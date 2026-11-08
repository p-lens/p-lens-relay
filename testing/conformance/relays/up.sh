#!/usr/bin/env bash
# Starts the relays the conformance tests are run against, by podman.
set -euo pipefail
cd "$(dirname "$0")"
podman rm -f plr-nostr-rs plr-strfry >/dev/null 2>&1 || true
podman volume create plr-strfry-db >/dev/null 2>&1 || true
podman run -d --name plr-nostr-rs -p 7777:8080 docker.io/scsibug/nostr-rs-relay:latest >/dev/null
podman run -d --name plr-strfry -p 7778:7777 -v plr-strfry-db:/app/strfry-db -v ./strfry.conf:/etc/strfry.conf:ro,Z docker.io/dockurr/strfry:latest >/dev/null
echo "nostr-rs-relay ws://127.0.0.1:7777"
echo "strfry         ws://127.0.0.1:7778"
