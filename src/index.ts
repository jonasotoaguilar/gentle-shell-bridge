/**
 * gentle-shell-bridge entry point.
 *
 * Pi loads this module through jiti, so the sources are the published artifact: there is no
 * build step and no `dist/`. Later work adds the bus, the interception backends, the store and
 * the `status` diagnostic; this entry stays minimal until then.
 */
export const VERSION = "0.0.0";
