#!/bin/bash
set -e

KEYDIR="$(dirname "$0")/../host-keys"
mkdir -p "$KEYDIR"

if [ ! -f "$KEYDIR/ssh_host_ed25519_key" ]; then
  ssh-keygen -t ed25519 -f "$KEYDIR/ssh_host_ed25519_key" -N "" -q
  echo "Generated ED25519 host key"
else
  echo "ED25519 host key already exists"
fi

if [ ! -f "$KEYDIR/ssh_host_rsa_key" ]; then
  ssh-keygen -t rsa -b 4096 -f "$KEYDIR/ssh_host_rsa_key" -N "" -q
  echo "Generated RSA host key"
else
  echo "RSA host key already exists"
fi
