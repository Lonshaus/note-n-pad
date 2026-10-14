# Privacy Policy — Note&Pad Lite

English · [正體中文](PRIVACY-Lite.zh-TW.md) · [日本語](PRIVACY-Lite.ja.md)

Last updated: 14 October 2026

**Note&Pad Lite collects nothing.** It has no accounts, no sign-in, no analytics, and no telemetry. It makes no network requests of its own, so no information about you or what you write ever leaves your Mac.

## What the app stores, and where

Everything the app writes stays on your own Mac:

- **Your files** are read from and written to the locations you choose. The app opens only what you hand it — through the open dialog, a drag onto a window, or Finder.
- **Settings** (interface mode, interface language, encoding preferences, window state) are stored in the app's own data folder.
- **Sticky notes and snapshots of unsaved work** are stored in the same place, so that content survives an unexpected shutdown. You can point the snapshot folder somewhere else in Settings.
- **Language files** you edit are plain data files in that folder.

Note&Pad Lite is installed from the Mac App Store, so that folder lives inside the app's sandbox container:

`~/Library/Containers/net.lonshaus.note-n-pad-lite/Data/Library/Application Support/net.lonshaus.note-n-pad-lite`

Nothing in that folder is transmitted anywhere. Deleting the app's data folder removes all of it.

## Network use

The app itself never connects to the internet.

The only outward action it can take is one you start: choosing **Documentation** or **Report an Issue** from the Help menu hands a web address to your default browser. From that point you are on a website, and that site's own privacy policy applies.

The app renders its interface with the system web view (WebKit), and that interface loads only files that ship inside the app. The one exception is the Markdown preview: with **Show local resources in preview** turned on, it can also display images from the folder of the document you opened. Those are read straight off your disk, never fetched over the network, and never from outside that document's own folder.

## Crash and error information

Nothing is ever sent anywhere. There is one file you should know about all the same.

While the app runs it keeps its own diagnostic messages in memory, in a buffer capped at 256 KB that normal operation never writes to disk. If the app hits an unexpected failure, that buffer is written out so the fault can be diagnosed:

`~/Library/Containers/net.lonshaus.note-n-pad-lite/Data/Library/Logs/net.lonshaus.note-n-pad-lite/diagnostic.log`

The file is overwritten each time, so it never grows past one buffer's worth. It holds the app's own messages, and those **can include the paths of files you had open**. It stays on your Mac, it is not read by anything but you, and you can delete it whenever you like.

Separately, the snapshot of your unsaved work also stays on your disk and is used only to give your content back the next time you open the app.

## Children

The app sends nothing anywhere, about anyone, children included. The only thing written on a failure is the diagnostic file described above, and it stays on your own Mac.

## Where you got the app

The Mac App Store may collect its own information about the download, the purchase, or crashes, under Apple's policy. That collection is Apple's, not ours, and we receive no personal information from it.

## Changes

If this policy changes, the date at the top changes with it, and the history is visible in this repository.

## Contact

Questions about this policy: https://github.com/Lonshaus/note-n-pad/issues
