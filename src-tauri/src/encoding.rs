// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

use crate::fs_ops::write_bytes_atomic;
use encoding_rs::Encoding;
use serde::Serialize;
use std::path::Path;

/// Result of decoding a byte buffer into text. `content` is BOM-free; line
/// endings are preserved (the frontend normalizes to LF).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Decoded {
  pub content: String,
  pub encoding: String,
  pub had_bom: bool,
  /// True when decoding produced U+FFFD replacement characters, i.e. the bytes
  /// did not fully fit the chosen encoding.
  pub lossy: bool,
}

/// The fixed set of encodings exposed to the frontend, paired with their
/// encoding_rs backing. The label (not encoding_rs's `.name()`) is what we
/// persist and show, so casing stays stable ("GB18030", "Windows-1252").
fn supported() -> [(&'static str, &'static Encoding); 22] {
  [
    ("UTF-8", encoding_rs::UTF_8),
    ("UTF-16LE", encoding_rs::UTF_16LE),
    ("UTF-16BE", encoding_rs::UTF_16BE),
    ("Big5", encoding_rs::BIG5),
    ("GB18030", encoding_rs::GB18030),
    ("GBK", encoding_rs::GBK),
    ("Shift_JIS", encoding_rs::SHIFT_JIS),
    ("EUC-JP", encoding_rs::EUC_JP),
    ("ISO-2022-JP", encoding_rs::ISO_2022_JP),
    ("EUC-KR", encoding_rs::EUC_KR),
    ("Windows-1252", encoding_rs::WINDOWS_1252),
    ("ISO-8859-15", encoding_rs::ISO_8859_15),
    ("Windows-1250", encoding_rs::WINDOWS_1250),
    ("Windows-1251", encoding_rs::WINDOWS_1251),
    ("KOI8-R", encoding_rs::KOI8_R),
    ("Windows-1253", encoding_rs::WINDOWS_1253),
    ("Windows-1254", encoding_rs::WINDOWS_1254),
    ("Windows-1255", encoding_rs::WINDOWS_1255),
    ("Windows-1256", encoding_rs::WINDOWS_1256),
    ("Windows-874", encoding_rs::WINDOWS_874),
    ("Windows-1258", encoding_rs::WINDOWS_1258),
    ("MacRoman", encoding_rs::MACINTOSH),
  ]
}

/// Whether `label` is one of the supported encoding labels (case-insensitive).
/// Exposed so settings validation reuses this single source of truth instead of
/// duplicating the encoding list.
pub fn is_supported_label(label: &str) -> bool {
  label_to_encoding(label).is_some()
}

/// Resolve a label (case-insensitive) to its encoding_rs encoding.
fn label_to_encoding(label: &str) -> Option<&'static Encoding> {
  supported()
    .into_iter()
    .find(|(name, _)| name.eq_ignore_ascii_case(label))
    .map(|(_, enc)| enc)
}

/// Map an encoding_rs encoding back to our fixed label.
fn label_for(enc: &'static Encoding) -> String {
  supported()
    .into_iter()
    .find(|(_, e)| std::ptr::eq(*e, enc))
    .map(|(name, _)| name.to_string())
    // Unreachable in practice: every path passes a supported encoding.
    .unwrap_or_else(|| "Windows-1252".to_string())
}

/// Constrain a detector guess to the supported list; unknown guesses fall back
/// to Windows-1252 (a superset-ish single-byte reading that never fails).
fn constrain(enc: &'static Encoding) -> &'static Encoding {
  if supported().into_iter().any(|(_, e)| std::ptr::eq(e, enc)) {
    enc
  } else {
    encoding_rs::WINDOWS_1252
  }
}

/// Decode `bytes` with `enc`, without any BOM handling (callers strip BOMs
/// explicitly). Returns the text and whether replacement characters appeared.
fn decode_bytes(enc: &'static Encoding, bytes: &[u8]) -> (String, bool) {
  let (cow, lossy) = enc.decode_without_bom_handling(bytes);
  (cow.into_owned(), lossy)
}

/// Auto-detect the encoding of `bytes` and decode it.
pub fn decode_auto(bytes: &[u8]) -> Decoded {
  // 1. BOM sniff wins outright.
  if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
    let (content, lossy) = decode_bytes(encoding_rs::UTF_8, rest);
    return Decoded {
      content,
      encoding: "UTF-8".into(),
      had_bom: true,
      lossy,
    };
  }
  if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
    let (content, lossy) = decode_bytes(encoding_rs::UTF_16LE, rest);
    return Decoded {
      content,
      encoding: "UTF-16LE".into(),
      had_bom: true,
      lossy,
    };
  }
  if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
    let (content, lossy) = decode_bytes(encoding_rs::UTF_16BE, rest);
    return Decoded {
      content,
      encoding: "UTF-16BE".into(),
      had_bom: true,
      lossy,
    };
  }
  // 2. ISO-2022-JP is pure ASCII plus escape sequences, so it would pass the
  // strict UTF-8 check below; sniff its JIS escape sequences first.
  if bytes
    .windows(3)
    .any(|w| w == b"\x1B$B" || w == b"\x1B$@" || w == b"\x1B(J")
  {
    let (content, lossy) = decode_bytes(encoding_rs::ISO_2022_JP, bytes);
    return Decoded {
      content,
      encoding: "ISO-2022-JP".into(),
      had_bom: false,
      lossy,
    };
  }
  // 3. Strict UTF-8: valid UTF-8 is always read as UTF-8.
  if let Ok(s) = std::str::from_utf8(bytes) {
    return Decoded {
      content: s.to_string(),
      encoding: "UTF-8".into(),
      had_bom: false,
      lossy: false,
    };
  }
  // 4. Statistical detection, constrained to the supported list.
  let mut detector = chardetng::EncodingDetector::new();
  detector.feed(bytes, true);
  let enc = constrain(detector.guess(None, true));
  let (content, lossy) = decode_bytes(enc, bytes);
  Decoded {
    content,
    encoding: label_for(enc),
    had_bom: false,
    lossy,
  }
}

/// Strip a BOM only when it matches `enc`, reporting whether one was removed.
fn strip_matching_bom<'a>(enc: &'static Encoding, bytes: &'a [u8]) -> (&'a [u8], bool) {
  let bom: &[u8] = if std::ptr::eq(enc, encoding_rs::UTF_8) {
    &[0xEF, 0xBB, 0xBF]
  } else if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
    &[0xFF, 0xFE]
  } else if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
    &[0xFE, 0xFF]
  } else {
    return (bytes, false);
  };
  match bytes.strip_prefix(bom) {
    Some(rest) => (rest, true),
    None => (bytes, false),
  }
}

/// Forced decode with a specific label.
pub fn decode_as(bytes: &[u8], label: &str) -> Result<Decoded, String> {
  let enc = label_to_encoding(label).ok_or_else(|| format!("unsupported encoding: {label}"))?;
  let (rest, had_bom) = strip_matching_bom(enc, bytes);
  let (content, lossy) = decode_bytes(enc, rest);
  Ok(Decoded {
    content,
    encoding: label_for(enc),
    had_bom,
    lossy,
  })
}

/// Encode text to `label`. UTF-8 optionally prepends a BOM; UTF-16 variants
/// always write their BOM; `with_bom` is ignored for non-Unicode encodings.
/// Characters that cannot be represented are a hard error (never silently dropped).
pub fn encode_text(content: &str, label: &str, with_bom: bool) -> Result<Vec<u8>, String> {
  let enc = label_to_encoding(label).ok_or_else(|| format!("unsupported encoding: {label}"))?;
  if std::ptr::eq(enc, encoding_rs::UTF_8) {
    let mut out = Vec::with_capacity(content.len() + 3);
    if with_bom {
      out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(content.as_bytes());
    return Ok(out);
  }
  // encoding_rs has no UTF-16 encoder (its output encoding is UTF-8), so build
  // the code units by hand. Every Unicode scalar maps, so this never fails.
  if std::ptr::eq(enc, encoding_rs::UTF_16LE) {
    let mut out = vec![0xFF, 0xFE];
    for unit in content.encode_utf16() {
      out.extend_from_slice(&unit.to_le_bytes());
    }
    return Ok(out);
  }
  if std::ptr::eq(enc, encoding_rs::UTF_16BE) {
    let mut out = vec![0xFE, 0xFF];
    for unit in content.encode_utf16() {
      out.extend_from_slice(&unit.to_be_bytes());
    }
    return Ok(out);
  }
  // Legacy single/double-byte encodings: encode and reject unmappable input.
  let (bytes, _, had_unmappable) = enc.encode(content);
  if had_unmappable {
    return Err(format!(
      "content contains characters that cannot be represented in {label}"
    ));
  }
  Ok(bytes.into_owned())
}

#[tauri::command]
pub fn read_file_auto(path: String) -> Result<Decoded, String> {
  let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
  Ok(decode_auto(&bytes))
}

#[tauri::command]
pub fn read_file_as(path: String, encoding: String) -> Result<Decoded, String> {
  let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
  decode_as(&bytes, &encoding)
}

/// Off the UI thread: the encode + atomic write can run long on a large file.
/// Every call site awaits this one call before its next action, so there is no
/// overlapping write to reorder.
#[tauri::command(async)]
pub fn write_file_encoded(
  path: String,
  content: String,
  encoding: String,
  with_bom: bool,
) -> Result<(), String> {
  let bytes = encode_text(&content, &encoding, with_bom)?;
  write_bytes_atomic(Path::new(&path), &bytes)
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::tempdir;

  #[test]
  fn bom_sniff_utf8() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("héllo".as_bytes());
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "UTF-8");
    assert!(d.had_bom);
    assert!(!d.lossy);
    assert_eq!(d.content, "héllo");
  }

  #[test]
  fn bom_sniff_utf16le() {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "héllo".encode_utf16() {
      bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "UTF-16LE");
    assert!(d.had_bom);
    assert_eq!(d.content, "héllo");
  }

  #[test]
  fn bom_sniff_utf16be() {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in "héllo".encode_utf16() {
      bytes.extend_from_slice(&unit.to_be_bytes());
    }
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "UTF-16BE");
    assert!(d.had_bom);
    assert_eq!(d.content, "héllo");
  }

  #[test]
  fn strict_utf8_no_bom() {
    let d = decode_auto("plain ascii and üñïçödé".as_bytes());
    assert_eq!(d.encoding, "UTF-8");
    assert!(!d.had_bom);
    assert!(!d.lossy);
  }

  #[test]
  fn big5_detection_roundtrip() {
    // Traditional-Chinese sample, long enough for statistical detection.
    let original = "這是一段用來測試繁體中文編碼偵測的範例文字，包含許多常見的字元。";
    let bytes = encode_text(original, "Big5", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "Big5");
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn shift_jis_detection_roundtrip() {
    // Japanese sample with kana, which chardetng reads as Shift_JIS.
    let original = "これはシフトジスの文字コードを判定するためのテスト用の文章です。";
    let bytes = encode_text(original, "Shift_JIS", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "Shift_JIS");
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn decode_as_forces_encoding() {
    // Bytes 0xB4 0xE1 are valid Big5 but arbitrary Windows-1252.
    let original = "測試";
    let bytes = encode_text(original, "Big5", false).unwrap();
    let forced = decode_as(&bytes, "Big5").unwrap();
    assert_eq!(forced.encoding, "Big5");
    assert_eq!(forced.content, original);
    // Forcing Windows-1252 over the same bytes yields different, non-empty text.
    let mis = decode_as(&bytes, "windows-1252").unwrap();
    assert_ne!(mis.content, original);
  }

  #[test]
  fn decode_as_strips_matching_bom() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("hi".as_bytes());
    let d = decode_as(&bytes, "UTF-8").unwrap();
    assert!(d.had_bom);
    assert_eq!(d.content, "hi");
  }

  #[test]
  fn lossy_flag_set_on_bad_bytes() {
    // 0xFF is not valid Shift_JIS and decodes to a replacement character.
    let d = decode_as(&[0x41, 0xFF, 0x42], "Shift_JIS").unwrap();
    assert!(d.lossy);
    assert!(d.content.contains('\u{FFFD}'));
  }

  #[test]
  fn encode_utf8_with_and_without_bom() {
    let without = encode_text("hi", "UTF-8", false).unwrap();
    assert_eq!(without, b"hi");
    let with = encode_text("hi", "UTF-8", true).unwrap();
    assert_eq!(with, vec![0xEF, 0xBB, 0xBF, b'h', b'i']);
  }

  #[test]
  fn encode_utf16_always_carries_bom() {
    let le = encode_text("A", "UTF-16LE", false).unwrap();
    assert_eq!(le, vec![0xFF, 0xFE, 0x41, 0x00]);
    let be = encode_text("A", "UTF-16BE", false).unwrap();
    assert_eq!(be, vec![0xFE, 0xFF, 0x00, 0x41]);
  }

  #[test]
  fn encode_ignores_bom_for_legacy_encoding() {
    // with_bom must not prepend anything for a non-Unicode encoding.
    let a = encode_text("abc", "Windows-1252", true).unwrap();
    let b = encode_text("abc", "Windows-1252", false).unwrap();
    assert_eq!(a, b);
    assert_eq!(a, b"abc");
  }

  #[test]
  fn encode_unmappable_char_errors() {
    // A traditional-Chinese character has no Windows-1252 representation.
    let err = encode_text("héllo 測", "Windows-1252", false).unwrap_err();
    assert!(err.contains("cannot be represented"));
  }

  #[test]
  fn every_label_resolves_and_maps_back() {
    for (label, enc) in supported() {
      assert!(std::ptr::eq(label_to_encoding(label).unwrap(), enc));
      assert_eq!(label_for(enc), label);
    }
  }

  #[test]
  fn gb18030_roundtrip() {
    let original = "这是一段用于测试GB18030编码的示例文字。";
    let bytes = encode_text(original, "GB18030", false).unwrap();
    // The known GB18030 encoding of "这" ("this"), so a mutated codec mapping
    // (not only wrong output text) gets caught.
    assert!(bytes.starts_with(&[0xD5, 0xE2]));
    let d = decode_as(&bytes, "GB18030").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn gb18030_supports_supplementary_plane_that_gbk_rejects() {
    // U+20000, a supplementary-plane CJK character. GB18030 encodes it as a
    // 4-byte sequence; GBK (2-byte only) has no representation for it, which
    // documents the exact difference between the two encoders.
    let original = "\u{20000}";
    let bytes = encode_text(original, "GB18030", false).unwrap();
    let d = decode_as(&bytes, "GB18030").unwrap();
    assert_eq!(d.content, original);
    let err = encode_text(original, "GBK", false).unwrap_err();
    assert!(err.contains("cannot be represented"));
  }

  #[test]
  fn gbk_roundtrip() {
    // Common simplified-Chinese characters, all within GBK's 2-byte repertoire.
    let original = "这是一段用于测试GBK编码的示例文字。";
    let bytes = encode_text(original, "GBK", false).unwrap();
    assert!(bytes.starts_with(&[0xD5, 0xE2]));
    let d = decode_as(&bytes, "GBK").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn euc_kr_roundtrip() {
    let original = "이것은 EUC-KR 인코딩을 테스트하기 위한 한국어 문장입니다.";
    let bytes = encode_text(original, "EUC-KR", false).unwrap();
    // The known EUC-KR encoding of "이" ("this"/subject marker).
    assert!(bytes.starts_with(&[0xC0, 0xCC]));
    let d = decode_as(&bytes, "EUC-KR").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn iso_8859_15_roundtrip() {
    // Includes the Euro sign, the character that distinguishes -15 from -1.
    let original = "Le prix est de 20 € pour ce produit très cher.";
    let bytes = encode_text(original, "ISO-8859-15", false).unwrap();
    // 0xA4 is the Euro sign under -15; under plain ISO-8859-1 it's the
    // generic currency sign, so this byte pins us to the right variant.
    assert!(bytes.contains(&0xA4));
    let d = decode_as(&bytes, "ISO-8859-15").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1250_roundtrip() {
    // Czech pangram, exercising Central European diacritics.
    let original = "Příliš žluťoučký kůň úpěl ďábelské ódy.";
    let bytes = encode_text(original, "Windows-1250", false).unwrap();
    // 0xF8 is "ř" under Windows-1250, a byte most other single-byte code
    // pages either leave unassigned or map to something else entirely.
    assert!(bytes.contains(&0xF8));
    let d = decode_as(&bytes, "Windows-1250").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn koi8_r_roundtrip() {
    let original = "Привет, это тест кодировки КОИ8-Р.";
    let bytes = encode_text(original, "KOI8-R", false).unwrap();
    // The known KOI8-R encoding of "П", the first Cyrillic letter here.
    // KOI8-R's Cyrillic layout doesn't follow ISO/Windows Cyrillic ordering,
    // so this byte pins us to KOI8-R specifically and not Windows-1251.
    assert!(bytes.starts_with(&[0xF0]));
    let d = decode_as(&bytes, "KOI8-R").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1253_roundtrip() {
    let original = "Αυτό είναι ένα δοκιμαστικό κείμενο στα ελληνικά.";
    let bytes = encode_text(original, "Windows-1253", false).unwrap();
    // The known Windows-1253 encoding of "Α" (Greek capital alpha).
    assert!(bytes.starts_with(&[0xC1]));
    let d = decode_as(&bytes, "Windows-1253").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1254_roundtrip() {
    // Turkish characters not present in Windows-1252 (ğ, ş, ı).
    let original = "Bu, Türkçe karakterler içeren bir test metnidir: ğüşıöç.";
    let bytes = encode_text(original, "Windows-1254", false).unwrap();
    // 0xF0 is "ğ" (g-breve) under Windows-1254, the letter that most clearly
    // distinguishes Turkish's code page from the rest of the Windows-125x family.
    assert!(bytes.contains(&0xF0));
    let d = decode_as(&bytes, "Windows-1254").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1255_roundtrip() {
    let original = "זהו טקסט בדיקה בעברית.";
    let bytes = encode_text(original, "Windows-1255", false).unwrap();
    // The known Windows-1255 encoding of "ז" (Hebrew letter zayin).
    assert!(bytes.starts_with(&[0xE6]));
    let d = decode_as(&bytes, "Windows-1255").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1256_roundtrip() {
    let original = "هذا نص تجريبي باللغة العربية.";
    let bytes = encode_text(original, "Windows-1256", false).unwrap();
    // The known Windows-1256 encoding of "ه" (Arabic letter heh).
    assert!(bytes.starts_with(&[0xE5]));
    let d = decode_as(&bytes, "Windows-1256").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_874_roundtrip() {
    let original = "นี่คือข้อความทดสอบภาษาไทย";
    let bytes = encode_text(original, "Windows-874", false).unwrap();
    // The known Windows-874 (TIS-620-based) encoding of "น" (Thai letter no nu).
    assert!(bytes.starts_with(&[0xB9]));
    let d = decode_as(&bytes, "Windows-874").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn windows_1258_roundtrip() {
    // Windows-1258 has no precomposed slot for every Vietnamese vowel/tone
    // combination (e.g. U+1ED9 "ộ" is unmappable), so genuine Windows-1258
    // text stores such letters decomposed: a precomposed base letter (ô, ê,
    // â, …) followed by a combining tone mark. This sample uses that form,
    // which is exactly what real Windows-1258 documents contain.
    let original = "Đây là mô\u{323}t câu tiê\u{301}ng Viê\u{323}t có dâ\u{301}u.";
    let bytes = encode_text(original, "Windows-1258", false).unwrap();
    // The known Windows-1258 encoding of "Đ" (D with stroke), a letter absent
    // from every other Windows-125x/ISO code page in this list.
    assert!(bytes.starts_with(&[0xD0]));
    let d = decode_as(&bytes, "Windows-1258").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn macroman_roundtrip() {
    let original = "Café à la crème, très élégant.";
    let bytes = encode_text(original, "MacRoman", false).unwrap();
    // "é" is 0x8E under MacRoman, unlike 0xE9 under every Windows/ISO Latin
    // code page, so this pins us to the classic Mac OS Roman table.
    assert!(bytes.contains(&0x8E));
    let d = decode_as(&bytes, "MacRoman").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn euc_jp_detection_roundtrip() {
    let original = "これは日本語の文章で、文字コードの自動判定を確認するためのものです。";
    let bytes = encode_text(original, "EUC-JP", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "EUC-JP");
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn iso_2022_jp_roundtrip() {
    // ISO-2022-JP uses escape sequences; detection keys off them directly.
    let original = "日本語のメールでよく使われる文字コードです。";
    let bytes = encode_text(original, "ISO-2022-JP", false).unwrap();
    let d = decode_auto(&bytes);
    assert_eq!(d.encoding, "ISO-2022-JP");
    assert_eq!(d.content, original);
    let forced = decode_as(&bytes, "ISO-2022-JP").unwrap();
    assert_eq!(forced.content, original);
  }

  #[test]
  fn windows_1251_roundtrip() {
    let original = "Это тестовый текст на русском языке для проверки кодировки.";
    let bytes = encode_text(original, "Windows-1251", false).unwrap();
    let d = decode_as(&bytes, "Windows-1251").unwrap();
    assert_eq!(d.content, original);
    assert!(!d.lossy);
  }

  #[test]
  fn write_file_encoded_writes_expected_bytes() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("doc.txt");
    write_file_encoded(
      path.to_string_lossy().into_owned(),
      "hi".into(),
      "UTF-16LE".into(),
      false,
    )
    .unwrap();
    let read = std::fs::read(&path).unwrap();
    assert_eq!(read, vec![0xFF, 0xFE, b'h', 0x00, b'i', 0x00]);
    // Round-trips back through auto detection.
    assert_eq!(decode_auto(&read).content, "hi");
  }
}
