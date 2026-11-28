# The image of deploy/synology, made to behave like the NAS in one respect: the
# nftables flavour of iptables is gone, so `auto` has to take iptables-legacy.
# (There is no `nft` in the image to begin with.) The kernel is the Docker host's.
ARG IMAGE
FROM ${IMAGE}
RUN rm /usr/sbin/xtables-nft-multi && ! command -v nft
