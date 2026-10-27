#!/bin/sh
# The package's page in DSM. DSM links ui/ to /webman/3rdparty/wave/ and runs
# this for every request under it, as the package's user, with the request in
# the CGI environment -- the same arrangement as Tailscale's package. The
# binary answers it (`wave dsm-ui`, apps/client/src/dsm-ui.ts): DSM's sign-in,
# an administrator, then the daemon over its socket, which `scripts/setup`
# hands to this user as well.
exec /var/packages/wave/target/wave dsm-ui
