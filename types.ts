
export interface NodeStats {
  id: string;
  status: 'ONLINE' | 'OFFLINE' | 'SYNCING';
  uptime: string;
  bandwidth: string;
  rewards: number;
}

export interface ZKProofLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning';
}

export enum AppSection {
  HOME = 'HOME',
  NODE = 'NODE',
  VPN = 'VPN',
  WIKI = 'WIKI',
  ROADMAP = 'ROADMAP'
}

export interface WikiEntry {
  id: string;
  title: string;
  category: 'SETUP' | 'PROTOCOL' | 'MOBILE';
  content: string;
}
