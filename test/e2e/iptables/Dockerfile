# A Linux that has iptables-legacy and nothing else to filter with: no `nft`,
# and the nftables flavour of iptables taken out. That is what a kernel without
# nf_tables leaves (Synology DSM 7, 4.4) -- as far as userspace goes; the
# kernel underneath is still the Docker host's.
FROM oven/bun:1.4.2-alpine
RUN apk add --no-cache iproute2 iptables iptables-legacy \
  && rm /usr/sbin/xtables-nft-multi \
  && ! command -v nft
WORKDIR /repo
