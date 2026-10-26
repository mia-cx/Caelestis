<script lang="ts">
  import type { PageData } from './$types';
  import 'virtual:svartz/tailwind-sources.css';
  import { page } from '$app/state';
  import SvartzRuntimePage from '@svartz/ui/runtime';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  {#each data.svartzStylesheets as stylesheet}
    <link rel="stylesheet" href={stylesheet} />
  {/each}
</svelte:head>

<SvartzRuntimePage pathname={page.url.pathname} />
