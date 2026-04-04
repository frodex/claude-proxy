// src/launch-profiles.ts — registry for SSH/API session launch kinds (shell / Claude / Cursor).

export interface ProfileCapabilities {
  fork: boolean;
  resume: boolean;
  sessionIdBackfill: boolean;
  dangerMode: boolean;
  remoteSupport: boolean;
}

export interface LaunchProfile {
  id: string;
  label: string;
  key: string;
  command: string;
  defaultArgs: string[];
  useLauncher: boolean;
  capabilities: ProfileCapabilities;
}

const PROFILES: LaunchProfile[] = [
  {
    id: 'shell',
    label: 'New terminal',
    key: 't',
    command: '/bin/bash',
    defaultArgs: ['-l'],
    useLauncher: false,
    capabilities: { fork: false, resume: false, sessionIdBackfill: false, dangerMode: false, remoteSupport: false },
  },
  {
    id: 'claude',
    label: 'New Claude session',
    key: 'n',
    command: 'claude',
    defaultArgs: [],
    useLauncher: true,
    capabilities: { fork: true, resume: true, sessionIdBackfill: true, dangerMode: true, remoteSupport: true },
  },
  {
    id: 'cursor',
    label: 'New Cursor session',
    key: 'c',
    command: 'cursor',
    defaultArgs: [],
    useLauncher: false,
    capabilities: { fork: false, resume: false, sessionIdBackfill: false, dangerMode: false, remoteSupport: false },
  },
];

export function listProfiles(): LaunchProfile[] {
  return PROFILES;
}

export function getProfile(id: string): LaunchProfile | undefined {
  return PROFILES.find(p => p.id === id);
}

export function resolveCommand(profileId: string): { command: string; useLauncher: boolean } {
  const profile = getProfile(profileId);
  if (!profile) throw new Error(`Unknown launch profile: ${profileId}`);
  return { command: profile.command, useLauncher: profile.useLauncher };
}

export function buildCommandArgs(
  profileId: string,
  options: { isResume?: boolean; claudeSessionId?: string; dangerousSkipPermissions?: boolean },
): string[] {
  const profile = getProfile(profileId);
  if (!profile) throw new Error(`Unknown launch profile: ${profileId}`);

  const args = [...profile.defaultArgs];

  if (profile.capabilities.resume && options.isResume) {
    args.push('--resume');
    if (options.claudeSessionId) args.push(options.claudeSessionId);
  }

  if (profile.capabilities.dangerMode && options.dangerousSkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  return args;
}
