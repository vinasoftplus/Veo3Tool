// Proxy Manager - Quản lý và xoay proxy cho extension
// Hỗ trợ HTTP/HTTPS/SOCKS4/SOCKS5 proxy

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentProxyIndex = -1;
    this.autoRotate = false;
    this.rotateInterval = null;
    this.rotateIntervalMinutes = 5;
    this.proxyStats = new Map(); // Track proxy performance
    this.isProxyEnabled = false;
    this.pendingAuth = null; // Store credentials for auto-authentication
    
    // Setup proxy authentication handler
    this.setupAuthHandler();
    
    // Load saved config
    this.loadConfig();
  }

  /**
   * Setup handler for proxy authentication
   * Automatically provides credentials when proxy requires auth
   */
  setupAuthHandler() {
    // Remove existing listener if any
    if (chrome.webRequest?.onAuthRequired?.hasListener(this.handleAuthRequired)) {
      chrome.webRequest.onAuthRequired.removeListener(this.handleAuthRequired);
    }

    // Bind the handler to this instance
    this.handleAuthRequired = (details, callback) => {
      console.log('[ProxyManager] 🔐 Auth required for:', details.challenger?.host);
      
      // Get current proxy credentials
      const currentProxy = this.getCurrentProxy();
      
      if (currentProxy && currentProxy.username && currentProxy.password) {
        console.log('[ProxyManager] ✅ Auto-providing credentials for proxy:', currentProxy.host);
        
        // Return credentials
        if (callback) {
          // Callback mode (async)
          callback({
            authCredentials: {
              username: currentProxy.username,
              password: currentProxy.password
            }
          });
        } else {
          // Blocking mode (sync)
          return {
            authCredentials: {
              username: currentProxy.username,
              password: currentProxy.password
            }
          };
        }
      } else {
        console.warn('[ProxyManager] ⚠️ No credentials available for proxy auth');
        if (callback) {
          callback({ cancel: false });
        } else {
          return { cancel: false };
        }
      }
    };

    // Add listener for proxy authentication
    if (chrome.webRequest?.onAuthRequired) {
      chrome.webRequest.onAuthRequired.addListener(
        this.handleAuthRequired,
        { urls: ['<all_urls>'] },
        ['asyncBlocking']
      );
      console.log('[ProxyManager] ✅ Auth handler registered');
    } else {
      console.warn('[ProxyManager] ⚠️ webRequest.onAuthRequired not available');
    }
  }

  /**
   * Load proxy config from storage
   */
  async loadConfig() {
    try {
      const data = await chrome.storage.local.get([
        'proxies',
        'currentProxyIndex',
        'autoRotate',
        'rotateIntervalMinutes',
        'isProxyEnabled',
        'proxyStats'
      ]);

      this.proxies = data.proxies || [];
      this.currentProxyIndex = data.currentProxyIndex ?? -1;
      this.autoRotate = data.autoRotate || false;
      this.rotateIntervalMinutes = data.rotateIntervalMinutes || 5;
      this.isProxyEnabled = data.isProxyEnabled || false;
      
      if (data.proxyStats) {
        this.proxyStats = new Map(Object.entries(data.proxyStats));
      }

      console.log('[ProxyManager] Config loaded:', {
        proxiesCount: this.proxies.length,
        currentIndex: this.currentProxyIndex,
        autoRotate: this.autoRotate,
        isEnabled: this.isProxyEnabled
      });

      // Apply current proxy if enabled
      if (this.isProxyEnabled && this.currentProxyIndex >= 0) {
        await this.applyCurrentProxy();
      }

      // Start auto-rotate if enabled
      if (this.autoRotate) {
        this.startAutoRotate();
      }
    } catch (error) {
      console.error('[ProxyManager] Error loading config:', error);
    }
  }

  /**
   * Save config to storage
   */
  async saveConfig() {
    try {
      const statsObj = Object.fromEntries(this.proxyStats);
      
      await chrome.storage.local.set({
        proxies: this.proxies,
        currentProxyIndex: this.currentProxyIndex,
        autoRotate: this.autoRotate,
        rotateIntervalMinutes: this.rotateIntervalMinutes,
        isProxyEnabled: this.isProxyEnabled,
        proxyStats: statsObj
      });

      console.log('[ProxyManager] Config saved');
    } catch (error) {
      console.error('[ProxyManager] Error saving config:', error);
    }
  }

  /**
   * Parse proxy string
   * Formats: 
   * - host:port
   * - host:port:username:password (new format)
   * - username:password@host:port
   * - protocol://host:port
   * - protocol://username:password@host:port
   */
  parseProxy(proxyString) {
    try {
      proxyString = proxyString.trim();
      
      let protocol = 'http';
      let host, port, username, password;

      // Extract protocol if present
      const protocolMatch = proxyString.match(/^(https?|socks4|socks5):\/\//i);
      if (protocolMatch) {
        protocol = protocolMatch[1].toLowerCase();
        proxyString = proxyString.substring(protocolMatch[0].length);
      }

      // Check for format: host:port:username:password (new format)
      const newFormatMatch = proxyString.match(/^([^:]+):(\d+):([^:]+):(.+)$/);
      if (newFormatMatch) {
        host = newFormatMatch[1];
        port = parseInt(newFormatMatch[2]);
        username = newFormatMatch[3];
        password = newFormatMatch[4];
        
        if (!host || !port || port < 1 || port > 65535 || !username || !password) {
          throw new Error('Invalid proxy format: host:port:username:password');
        }

        return {
          id: this.generateProxyId(host, port, username),
          protocol,
          host,
          port,
          username,
          password,
          enabled: true,
          addedAt: Date.now()
        };
      }

      // Extract auth if present (old format: username:password@host:port)
      const authMatch = proxyString.match(/^([^:]+):([^@]+)@(.+)$/);
      if (authMatch) {
        username = authMatch[1];
        password = authMatch[2];
        proxyString = authMatch[3];
      }

      // Extract host:port
      const hostPortMatch = proxyString.match(/^([^:]+):(\d+)$/);
      if (!hostPortMatch) {
        throw new Error('Invalid proxy format. Supported formats: host:port, host:port:username:password, username:password@host:port');
      }

      host = hostPortMatch[1];
      port = parseInt(hostPortMatch[2]);

      if (!host || !port || port < 1 || port > 65535) {
        throw new Error('Invalid host or port');
      }

      return {
        id: this.generateProxyId(host, port, username),
        protocol,
        host,
        port,
        username,
        password,
        enabled: true,
        addedAt: Date.now()
      };
    } catch (error) {
      throw new Error(`Parse error: ${error.message}`);
    }
  }

  /**
   * Generate unique proxy ID
   */
  generateProxyId(host, port, username) {
    const base = `${host}:${port}${username ? ':' + username : ''}`;
    // Sử dụng toàn bộ base64 để tránh collision, hoặc có thể dùng hash
    return btoa(base).replace(/[+/=]/g, '').substring(0, 32);
  }

  /**
   * Check if proxy already exists by comparing host, port, and username
   */
  isProxyDuplicate(proxy) {
    return this.proxies.some(p => 
      p.host === proxy.host && 
      p.port === proxy.port && 
      (p.username || '') === (proxy.username || '')
    );
  }

  /**
   * Add proxy to list
   */
  async addProxy(proxyString) {
    try {
      const proxy = this.parseProxy(proxyString);
      
      // Check duplicate bằng cách so sánh host, port và username (chính xác hơn)
      if (this.isProxyDuplicate(proxy)) {
        throw new Error(`Proxy already exists: ${proxy.host}:${proxy.port}${proxy.username ? ' (user: ' + proxy.username + ')' : ''}`);
      }

      this.proxies.push(proxy);
      await this.saveConfig();

      console.log('[ProxyManager] Proxy added:', `${proxy.host}:${proxy.port}`);
      return proxy;
    } catch (error) {
      console.error('[ProxyManager] Error adding proxy:', error);
      throw error;
    }
  }

  /**
   * Add multiple proxies from text (one per line)
   */
  async addProxiesFromText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const results = {
      added: [],
      failed: []
    };

    for (const line of lines) {
      try {
        const proxy = await this.addProxy(line);
        results.added.push(proxy);
      } catch (error) {
        results.failed.push({ line, error: error.message });
      }
    }

    return results;
  }

  /**
   * Remove proxy by ID
   */
  async removeProxy(proxyId) {
    const index = this.proxies.findIndex(p => p.id === proxyId);
    if (index === -1) {
      throw new Error('Proxy not found');
    }

    this.proxies.splice(index, 1);
    
    // Adjust current index if needed
    if (this.currentProxyIndex >= this.proxies.length) {
      this.currentProxyIndex = this.proxies.length - 1;
    }

    await this.saveConfig();
    console.log('[ProxyManager] Proxy removed');
  }

  /**
   * Toggle proxy enabled state
   */
  async toggleProxy(proxyId) {
    const proxy = this.proxies.find(p => p.id === proxyId);
    if (!proxy) {
      throw new Error('Proxy not found');
    }

    proxy.enabled = !proxy.enabled;
    await this.saveConfig();
    
    return proxy.enabled;
  }

  /**
   * Clear all proxies
   */
  async clearAllProxies() {
    this.proxies = [];
    this.currentProxyIndex = -1;
    await this.saveConfig();
    await this.disableProxy();
    
    console.log('[ProxyManager] All proxies cleared');
  }

  /**
   * Get current proxy
   */
  getCurrentProxy() {
    if (this.currentProxyIndex < 0 || this.currentProxyIndex >= this.proxies.length) {
      return null;
    }
    return this.proxies[this.currentProxyIndex];
  }

  /**
   * Get next enabled proxy (for rotation)
   */
  getNextEnabledProxy() {
    if (this.proxies.length === 0) {
      return null;
    }

    const enabledProxies = this.proxies.filter(p => p.enabled);
    if (enabledProxies.length === 0) {
      return null;
    }

    // Find next enabled proxy after current
    let nextIndex = (this.currentProxyIndex + 1) % this.proxies.length;
    let attempts = 0;

    while (attempts < this.proxies.length) {
      if (this.proxies[nextIndex].enabled) {
        this.currentProxyIndex = nextIndex;
        return this.proxies[nextIndex];
      }
      nextIndex = (nextIndex + 1) % this.proxies.length;
      attempts++;
    }

    return null;
  }

  /**
   * Apply proxy configuration to Chrome
   */
  async applyProxy(proxy) {
    if (!proxy) {
      throw new Error('No proxy provided');
    }

    try {
      const config = {
        mode: 'fixed_servers',
        rules: {
          singleProxy: {
            scheme: proxy.protocol === 'socks4' ? 'socks4' :
                    proxy.protocol === 'socks5' ? 'socks5' :
                    proxy.protocol === 'https' ? 'https' : 'http',
            host: proxy.host,
            port: proxy.port
          },
          bypassList: ['localhost', '127.0.0.1', '<local>']
        }
      };

      console.log('[ProxyManager] Applying proxy config:', JSON.stringify(config, null, 2));

      // Use callback-based API for better compatibility
      return new Promise((resolve, reject) => {
        chrome.proxy.settings.set(
          {
            value: config,
            scope: 'regular'
          },
          () => {
            if (chrome.runtime.lastError) {
              console.error('[ProxyManager] Chrome API error:', chrome.runtime.lastError);
              this.updateProxyStats(proxy.id, 'error');
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              this.isProxyEnabled = true;
              this.saveConfig().then(() => {
                this.updateProxyStats(proxy.id, 'applied');
                console.log('[ProxyManager] ✅ Proxy applied:', `${proxy.host}:${proxy.port}`);
                resolve(true);
              });
            }
          }
        );
      });
    } catch (error) {
      console.error('[ProxyManager] ❌ Error applying proxy:', error);
      this.updateProxyStats(proxy.id, 'error');
      throw error;
    }
  }

  /**
   * Apply current proxy
   */
  async applyCurrentProxy() {
    const proxy = this.getCurrentProxy();
    if (!proxy) {
      throw new Error('No current proxy');
    }
    return await this.applyProxy(proxy);
  }

  /**
   * Disable proxy (direct connection)
   */
  async disableProxy() {
    try {
      return new Promise((resolve, reject) => {
        chrome.proxy.settings.set(
          {
            value: { mode: 'direct' },
            scope: 'regular'
          },
          () => {
            if (chrome.runtime.lastError) {
              console.error('[ProxyManager] Chrome API error:', chrome.runtime.lastError);
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              this.isProxyEnabled = false;
              this.saveConfig().then(() => {
                console.log('[ProxyManager] ✅ Proxy disabled (direct connection)');
                resolve(true);
              });
            }
          }
        );
      });
    } catch (error) {
      console.error('[ProxyManager] ❌ Error disabling proxy:', error);
      throw error;
    }
  }

  /**
   * Rotate to next proxy
   */
  async rotateProxy() {
    const nextProxy = this.getNextEnabledProxy();
    
    if (!nextProxy) {
      console.warn('[ProxyManager] No enabled proxy to rotate to');
      return null;
    }

    await this.applyProxy(nextProxy);
    await this.saveConfig();

    console.log('[ProxyManager] 🔄 Rotated to proxy:', `${nextProxy.host}:${nextProxy.port}`);
    
    return nextProxy;
  }

  /**
   * Start auto-rotate
   */
  startAutoRotate() {
    this.stopAutoRotate(); // Clear existing interval

    if (this.proxies.length === 0) {
      console.warn('[ProxyManager] No proxies to rotate');
      return;
    }

    this.autoRotate = true;
    const intervalMs = this.rotateIntervalMinutes * 60 * 1000;

    this.rotateInterval = setInterval(async () => {
      console.log('[ProxyManager] 🔄 Auto-rotating proxy...');
      try {
        await this.rotateProxy();
      } catch (error) {
        console.error('[ProxyManager] Auto-rotate error:', error);
      }
    }, intervalMs);

    this.saveConfig();
    console.log(`[ProxyManager] ✅ Auto-rotate started (${this.rotateIntervalMinutes} min)`);
  }

  /**
   * Stop auto-rotate
   */
  stopAutoRotate() {
    if (this.rotateInterval) {
      clearInterval(this.rotateInterval);
      this.rotateInterval = null;
    }
    this.autoRotate = false;
    this.saveConfig();
    
    console.log('[ProxyManager] ⏹️ Auto-rotate stopped');
  }

  /**
   * Set auto-rotate interval
   */
  async setRotateInterval(minutes) {
    if (minutes < 1) {
      throw new Error('Interval must be at least 1 minute');
    }

    this.rotateIntervalMinutes = minutes;
    await this.saveConfig();

    // Restart if currently running
    if (this.autoRotate) {
      this.startAutoRotate();
    }

    console.log(`[ProxyManager] Rotate interval set to ${minutes} min`);
  }

  /**
   * Test proxy connection (Quick Test - Config Only)
   * Note: Cannot test directly from extension context, 
   * so we just apply and check if it applies successfully
   */
  async testProxy(proxy) {
    try {
      console.log(`[ProxyManager] Testing proxy: ${proxy.host}:${proxy.port}`);
      
      // Save current state
      const wasEnabled = this.isProxyEnabled;
      const previousIndex = this.currentProxyIndex;
      
      // Try to apply test proxy
      const testIndex = this.proxies.findIndex(p => p.id === proxy.id);
      if (testIndex >= 0) {
        this.currentProxyIndex = testIndex;
      }
      
      const startTime = Date.now();
      await this.applyProxy(proxy);
      const latency = Date.now() - startTime;

      // If apply succeeded, consider it a success
      // (actual connection test would require opening a tab)
      this.updateProxyStats(proxy.id, 'success', latency);

      // Restore previous state
      if (wasEnabled && previousIndex >= 0 && previousIndex !== testIndex) {
        this.currentProxyIndex = previousIndex;
        await this.applyCurrentProxy();
      } else if (!wasEnabled) {
        await this.disableProxy();
      }

      console.log(`[ProxyManager] Test result: ✅ Proxy applied successfully (${latency}ms)`);
      
      return {
        success: true,
        latency,
        message: 'Proxy configuration applied successfully',
        testType: 'quick'
      };
    } catch (error) {
      console.error(`[ProxyManager] Test failed:`, error.message);
      this.updateProxyStats(proxy.id, 'failed');
      
      return {
        success: false,
        error: error.message,
        testType: 'quick'
      };
    }
  }

  /**
   * Test proxy with real connection (Real Test - Connection Verified)
   * This actually fetches from an external service to verify the proxy works
   */
  async testProxyWithRealConnection(proxy) {
    try {
      console.log(`[ProxyManager] 🔥 Real connection test for proxy: ${proxy.host}:${proxy.port}`);
      
      // Save current state
      const wasEnabled = this.isProxyEnabled;
      const previousProxy = wasEnabled && this.currentProxyIndex >= 0 
        ? this.proxies[this.currentProxyIndex] 
        : null;
      const previousIndex = this.currentProxyIndex;
      
      // Get current IP before test (for comparison)
      let oldIP = null;
      try {
        if (typeof cachedExternalIP !== 'undefined' && cachedExternalIP) {
          oldIP = cachedExternalIP.ip;
        }
      } catch (e) {
        // Ignore if cachedExternalIP not available
      }

      // Apply test proxy
      const testIndex = this.proxies.findIndex(p => p.id === proxy.id);
      if (testIndex >= 0) {
        this.currentProxyIndex = testIndex;
      }
      await this.applyProxy(proxy);
      
      // Wait for proxy to stabilize
      console.log(`[ProxyManager] ⏳ Waiting 500ms for proxy to stabilize...`);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Fetch real IP through proxy
      console.log(`[ProxyManager] 🌐 Fetching external IP through proxy...`);
      const startTime = Date.now();
      
      const response = await fetch('https://ipinfo.io/json', {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      const latency = Date.now() - startTime;
      
      console.log(`[ProxyManager] ✅ Got response:`, data);
      
      // Verify results
      const ipChanged = oldIP ? (data.ip !== oldIP) : true;
      const hasValidIP = data.ip && data.ip.length > 0;
      const hasCountry = data.country && data.country.length > 0;
      
      // Update stats
      this.updateProxyStats(proxy.id, 'success', latency);
      
      // Restore previous state
      try {
        if (wasEnabled && previousIndex >= 0 && previousIndex !== testIndex && previousProxy) {
          console.log(`[ProxyManager] 🔄 Restoring previous proxy: ${previousProxy.host}:${previousProxy.port}`);
          this.currentProxyIndex = previousIndex;
          await this.applyCurrentProxy();
        } else if (!wasEnabled) {
          console.log(`[ProxyManager] 🔄 Disabling proxy (was not enabled before)`);
          await this.disableProxy();
        } else {
          console.log(`[ProxyManager] ✓ Keeping test proxy (was testing current proxy)`);
        }
      } catch (restoreError) {
        console.error(`[ProxyManager] ⚠️ Failed to restore previous state:`, restoreError);
      }
      
      console.log(`[ProxyManager] 🎉 Real connection test completed (${latency}ms)`);
      
      return {
        success: hasValidIP && hasCountry,
        latency,
        ip: data.ip,
        country: data.country,
        city: data.city || 'Unknown',
        region: data.region || 'Unknown',
        ipChanged,
        verified: true,
        testType: 'real',
        message: `Real connection verified - ${data.country}`
      };
      
    } catch (error) {
      console.error(`[ProxyManager] ❌ Real connection test failed:`, error.message);
      this.updateProxyStats(proxy.id, 'failed');
      
      // Try to restore previous state even on error
      try {
        const wasEnabled = this.isProxyEnabled;
        const previousIndex = this.currentProxyIndex;
        const testIndex = this.proxies.findIndex(p => p.id === proxy.id);
        
        if (wasEnabled && previousIndex >= 0 && previousIndex !== testIndex) {
          this.currentProxyIndex = previousIndex;
          await this.applyCurrentProxy();
        } else if (!wasEnabled) {
          await this.disableProxy();
        }
      } catch (restoreError) {
        console.error(`[ProxyManager] ⚠️ Failed to restore after error:`, restoreError);
      }
      
      return {
        success: false,
        error: error.message,
        verified: false,
        testType: 'real',
        message: `Connection failed: ${error.message}`
      };
    }
  }

  /**
   * Update proxy statistics
   */
  updateProxyStats(proxyId, event, latency = null) {
    if (!this.proxyStats.has(proxyId)) {
      this.proxyStats.set(proxyId, {
        applied: 0,
        success: 0,
        failed: 0,
        errors: 0,
        totalLatency: 0,
        testCount: 0,
        lastUsed: null
      });
    }

    const stats = this.proxyStats.get(proxyId);

    switch (event) {
      case 'applied':
        stats.applied++;
        stats.lastUsed = Date.now();
        break;
      case 'success':
        stats.success++;
        stats.testCount++;
        if (latency) stats.totalLatency += latency;
        break;
      case 'failed':
        stats.failed++;
        stats.testCount++;
        break;
      case 'error':
        stats.errors++;
        break;
    }

    this.saveConfig();
  }

  /**
   * Get proxy statistics
   */
  getProxyStats(proxyId) {
    return this.proxyStats.get(proxyId) || null;
  }

  /**
   * Get all proxies with stats
   */
  getProxiesWithStats() {
    return this.proxies.map(proxy => {
      const stats = this.getProxyStats(proxy.id);
      const avgLatency = stats && stats.testCount > 0 
        ? Math.round(stats.totalLatency / stats.testCount)
        : null;

      return {
        ...proxy,
        stats: stats ? {
          ...stats,
          avgLatency,
          successRate: stats.testCount > 0 
            ? Math.round((stats.success / stats.testCount) * 100)
            : null
        } : null
      };
    });
  }

  /**
   * Export proxies to text
   */
  exportProxies() {
    return this.proxies.map(p => {
      let str = '';
      if (p.protocol !== 'http') {
        str += `${p.protocol}://`;
      }
      if (p.username && p.password) {
        str += `${p.username}:${p.password}@`;
      }
      str += `${p.host}:${p.port}`;
      return str;
    }).join('\n');
  }

  /**
   * Get proxy manager status
   */
  getStatus() {
    const currentProxy = this.getCurrentProxy();
    
    return {
      isEnabled: this.isProxyEnabled,
      totalProxies: this.proxies.length,
      enabledProxies: this.proxies.filter(p => p.enabled).length,
      currentProxy: currentProxy ? {
        host: currentProxy.host,
        port: currentProxy.port,
        protocol: currentProxy.protocol
      } : null,
      autoRotate: this.autoRotate,
      rotateInterval: this.rotateIntervalMinutes
    };
  }

  /**
   * Check if proxy is currently active
   */
  async isProxyActive() {
    // Check if proxy is enabled in manager
    if (!this.isProxyEnabled) {
      return false;
    }
    
    // Check if there's a current proxy
    const currentProxy = this.getCurrentProxy();
    if (!currentProxy) {
      return false;
    }
    
    // Check Chrome's actual proxy settings
    try {
      const config = await new Promise((resolve) => {
        chrome.proxy.settings.get({}, (config) => resolve(config));
      });
      
      // If mode is not 'direct', proxy is active
      return config.value.mode !== 'direct';
    } catch (error) {
      console.error('[ProxyManager] Error checking proxy status:', error);
      return false;
    }
  }
}

// Export singleton instance
const proxyManager = new ProxyManager();
