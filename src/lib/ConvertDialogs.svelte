<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import ConfirmModal from './ConfirmModal.svelte';
  import { convertController } from './state/convertController.svelte';

  const dialog = $derived(convertController.dialog);
</script>

{#if dialog !== null}
  <!-- The question a conversion to the large-file mode asks, or the report of
       its failure. Keyed so that the next question is a fresh dialog. -->
  {#key dialog.id}
    <ConfirmModal
      message={dialog.message}
      primaryLabel={dialog.primary}
      secondaryLabel={dialog.secondary}
      cancelLabel={dialog.cancel}
      onprimary={() => convertController.answer('primary')}
      onsecondary={() => convertController.answer('secondary')}
      oncancel={() => convertController.answer('cancel')}
    />
  {/key}
{/if}
