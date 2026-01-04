#!/usr/bin/env bash
set -euo pipefail

# DuckDNS updater (optioneel)
# Vul DUCKDNS_SUBDOMAIN en DUCKDNS_TOKEN in via /etc/default/duckdns of EnvironmentFile
# Werkt zonder "ip=" parameter: DuckDNS pakt je actuele WAN IP.

: "${DUCKDNS_SUBDOMAIN:?DUCKDNS_SUBDOMAIN not set}"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN not set}"

curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&verbose=true" | tee -a /var/log/duckdns.log
