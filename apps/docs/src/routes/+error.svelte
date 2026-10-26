<!-- A 404 renders the theme's own not-found page inside its layout. -->
<script lang="ts">
  import { page } from '$app/state';
  import SvartzRuntimePage from '@svartz/ui/runtime';
</script>

{#if page.status === 404}
  <SvartzRuntimePage pathname={page.url.pathname} />
{:else}
  <h1>{page.status}</h1>
  <p>{page.error?.message}</p>
{/if}
