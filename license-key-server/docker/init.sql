-- admin_users must come before banned_machines (foreign key dependency)
CREATE TABLE IF NOT EXISTS admin_users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  is_2fa_on     BOOLEAN DEFAULT FALSE,
  role          TEXT DEFAULT 'admin',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT chk_role CHECK (role IN ('admin','viewer'))
);

-- licenses: one row per issued key
CREATE TABLE IF NOT EXISTS licenses (
  id             BIGSERIAL PRIMARY KEY,
  key_hash       TEXT UNIQUE NOT NULL,
  license_type   SMALLINT NOT NULL DEFAULT 0,   -- 0=trial, 1=standard, 2=premium
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  max_devices    SMALLINT DEFAULT 1,
  status         TEXT DEFAULT 'active',          -- active | revoked | expired
  is_banned      BOOLEAN DEFAULT FALSE,
  ban_reason     TEXT,
  metadata       JSONB,
  CONSTRAINT chk_status CHECK (status IN ('active','revoked','expired')),
  CONSTRAINT chk_type   CHECK (license_type IN (0,1,2))
);
CREATE INDEX IF NOT EXISTS idx_lic_email   ON licenses(customer_email);
CREATE INDEX IF NOT EXISTS idx_lic_expires ON licenses(expires_at);
CREATE INDEX IF NOT EXISTS idx_lic_status  ON licenses(status);

-- activations: machine-to-license bindings
CREATE TABLE IF NOT EXISTS activations (
  id               BIGSERIAL PRIMARY KEY,
  license_id       BIGINT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  machine_id       TEXT NOT NULL,
  machine_name     TEXT DEFAULT '',
  activated_at     TIMESTAMPTZ DEFAULT NOW(),
  last_checked_at  TIMESTAMPTZ,
  ip_address       INET,
  is_revoked       BOOLEAN DEFAULT FALSE,
  UNIQUE(license_id, machine_id)
);
CREATE INDEX IF NOT EXISTS idx_act_license ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_act_machine ON activations(machine_id);

-- banned_machines: admin can ban a machine UUID with a reason
CREATE TABLE IF NOT EXISTS banned_machines (
  id          BIGSERIAL PRIMARY KEY,
  machine_id  TEXT UNIQUE NOT NULL,
  ban_reason  TEXT NOT NULL DEFAULT 'Bị cấm bởi quản trị viên',
  banned_at   TIMESTAMPTZ DEFAULT NOW(),
  banned_by   BIGINT REFERENCES admin_users(id),
  is_active   BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_ban_machine ON banned_machines(machine_id);

-- audit_log: append-only
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  admin_id      BIGINT REFERENCES admin_users(id),
  license_id    BIGINT REFERENCES licenses(id),
  activation_id BIGINT REFERENCES activations(id),
  machine_id    TEXT,
  ip_address    INET,
  details       JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_license ON audit_log(license_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event   ON audit_log(event_type, created_at DESC);

-- notifications: admin broadcasts to all tool users
CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  admin_id     BIGINT REFERENCES admin_users(id),
  title        TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  notif_type   TEXT NOT NULL DEFAULT 'info',  -- info | warning | error | success
  title_color  TEXT NOT NULL DEFAULT '#1e293b',
  message_color TEXT NOT NULL DEFAULT '#374151',
  bg_color     TEXT NOT NULL DEFAULT '#ffffff',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  CONSTRAINT chk_notif_type CHECK (notif_type IN ('info','warning','error','success'))
);
CREATE INDEX IF NOT EXISTS idx_notif_active ON notifications(is_active, created_at DESC);
