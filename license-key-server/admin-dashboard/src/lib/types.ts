export interface License {
  id: number;
  key_hash: string;
  license_type: number;
  customer_name: string;
  customer_email: string;
  created_at: string;
  expires_at: string;
  max_devices: number;
  status: 'active' | 'revoked' | 'expired';
}

export interface Activation {
  id: number;
  license_id: number;
  machine_id: string;
  machine_name: string;
  activated_at: string;
  last_checked_at: string | null;
  ip_address: string;
  is_revoked: boolean;
}

export interface Stats {
  total_licenses: number;
  active_licenses: number;
  revoked_licenses: number;
  expired_licenses: number;
  expiring_30d: number;
  active_activations: number;
  validations_today: number;
  banned_machines: number;
}

export interface BannedMachine {
  id: number;
  machine_id: string;
  ban_reason: string;
  banned_at: string;
  is_active: boolean;
}

export const LICENSE_TYPE_LABELS = ['Trial', 'Standard', 'Premium'];
