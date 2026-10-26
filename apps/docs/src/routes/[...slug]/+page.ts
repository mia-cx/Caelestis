import type { EntryGenerator } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { assets, base } from '$app/paths';
import { hostStylesheets, prepareHostVault, routes } from 'virtual:svartz/host';

export const load = async ({ url }) => {
  const appPath = base ? url.pathname.slice(base.length) || '/' : url.pathname;
  const pathname = appPath.endsWith('/') ? appPath : `${appPath}/`;
  const destination = routes.redirects[pathname];
  if (destination) redirect(308, `${base}${destination}`);
  await prepareHostVault(pathname);
  if (!routes.all.includes(pathname)) error(404);
  return { svartzStylesheets: hostStylesheets(pathname).map((file) => `${assets}/${file}`) };
};

export const entries: EntryGenerator = async () => routes.all
  .map((pathname) => ({ slug: pathname.replace(/^\/+|\/+$/g, '') }));
