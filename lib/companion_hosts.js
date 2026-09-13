'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadCompanionHosts(file) {
  const root = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = root.hosts || {default: root};
  const hosts = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error('Invalid companion host ID');
    const config = entry.config_path
      ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), entry.config_path), 'utf8')) : entry;
    if (typeof config.destination !== 'string' || !config.destination || config.destination.startsWith('-') || typeof config.remote_command !== 'string' || !config.remote_command)
      throw new Error(`Incomplete SSH configuration for host ${id}`);
    if (config.ssh_args !== undefined && (!Array.isArray(config.ssh_args) || config.ssh_args.some(x => typeof x !== 'string')))
      throw new Error(`Invalid SSH arguments for host ${id}`);
    hosts.set(id, {id, label: entry.label || config.label || id, config});
  }
  const defaultId = root.default_host || (hosts.size === 1 ? hosts.keys().next().value : null);
  if (defaultId && !hosts.has(defaultId)) throw new Error('Unknown default companion host');
  return {
    list: () => [...hosts.values()].map(({id, label}) => ({id, label})),
    get: id => {
      const host = hosts.get(id || defaultId);
      if (!host) throw new Error(id ? `Unknown companion host: ${id}` : 'Select a companion host explicitly.');
      return host;
    },
  };
}
module.exports = {loadCompanionHosts};
