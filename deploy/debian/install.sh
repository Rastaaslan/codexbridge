#!/bin/sh
# Run manually as root on Debian, from a reviewed checkout. Installs wiring only.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root on Debian' >&2; exit 1; }
[ -f /etc/debian_version ] || exit 1
cd "$(dirname "$0")/../.."
for command in node git sudo systemctl visudo; do command -v "$command" >/dev/null; done
/usr/bin/node -e 'if (+process.versions.node.split(".")[0] < 24) process.exit(1)'
getent group codexbridge >/dev/null || groupadd --system codexbridge
id codexbridge >/dev/null 2>&1 || useradd --system --gid codexbridge --home-dir /var/lib/codexbridge --shell /usr/sbin/nologin codexbridge
install -d -o root -g root -m 0755 /opt/codexbridge /usr/local/lib/codexbridge
install -d -o codexbridge -g codexbridge -m 0700 /var/lib/codexbridge /var/lib/codexbridge/codex /srv/codexbridge/repos
install -d -o codexbridge -g codexbridge -m 0750 /opt/codexbridge/releases
# The updater needs to atomically replace current; this tree contains no root-executed code.
chown codexbridge:codexbridge /opt/codexbridge
install -d -o root -g codexbridge -m 0750 /etc/codexbridge
install -o root -g root -m 0755 deploy/debian/codexbridge-control /usr/local/sbin/codexbridge-control
install -o root -g root -m 0644 scripts/self-update.mjs /usr/local/lib/codexbridge/self-update.mjs
install -o root -g root -m 0644 scripts/initial-release.mjs /usr/local/lib/codexbridge/initial-release.mjs
visudo -cf deploy/debian/sudoers
install -o root -g root -m 0440 deploy/debian/sudoers /etc/sudoers.d/codexbridge
for unit in codexbridge codexbridge-tunnel codexbridge-update codexbridge-recover codexbridge-recovery-health; do
  install -o root -g root -m 0644 "deploy/debian/$unit.service" "/etc/systemd/system/$unit.service"
done
if [ ! -e /etc/codexbridge/environment ]; then install -o root -g codexbridge -m 0640 deploy/debian/environment.example /etc/codexbridge/environment; fi
if [ ! -e /etc/codexbridge/update.json ]; then install -o root -g codexbridge -m 0640 deploy/debian/update.example.json /etc/codexbridge/update.json; fi
systemctl daemon-reload
systemctl enable codexbridge.service codexbridge-tunnel.service codexbridge-recovery-health.service
printf '%s\n' 'Installed without starting services. Complete MIGRATION.md prerequisites and initial release first.'
