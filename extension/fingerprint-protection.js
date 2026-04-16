// Fingerprint Protection - Anti-detection script
// Fake canvas, WebGL, Audio và các fingerprint khác

(function() {
  'use strict';
  
  // ============================================
  // 0. USER-AGENT PROTECTION (MAIN WORLD)
  // ============================================
  try {
    // Chọn 1 UA fake hợp lý cho Chrome trên Windows
    const FAKE_USER_AGENTS = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.265 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.91 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Safari/537.36"
    ];
    const originalUA = navigator.userAgent;
    const fakeUA = FAKE_USER_AGENTS[Math.floor(Math.random() * FAKE_USER_AGENTS.length)];

    // Override navigator.userAgent trong MAIN world
    Object.defineProperty(navigator, 'userAgent', {
      get() {
        return fakeUA;
      },
      configurable: true
    });

    console.log("[Fingerprint Protection] 🛡️ User-Agent overridden in page context:", originalUA, "→", fakeUA);
  } catch (e) {
    // Nếu override fail thì bỏ qua, không phá trang
  }
  
  // ============================================
  // 1. CANVAS FINGERPRINTING PROTECTION
  // ============================================
  
  // Lưu original methods
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  
  // Generate consistent noise cho canvas (có thể thay đổi mỗi N prompts)
  let canvasFingerprint = null;
  function getCanvasFingerprint() {
    if (!canvasFingerprint) {
      // Tạo fingerprint ngẫu nhiên nhưng consistent trong session
      const seed = Math.floor(Math.random() * 1000000);
      canvasFingerprint = seed;
    }
    return canvasFingerprint;
  }
  
  // Function để rotate canvas fingerprint (gọi từ extension)
  function rotateCanvasFingerprint() {
    const oldFingerprint = canvasFingerprint;
    canvasFingerprint = Math.floor(Math.random() * 1000000);
    console.log(`[Fingerprint Protection] 🔄 Canvas fingerprint rotated: ${oldFingerprint} → ${canvasFingerprint}`);
    return canvasFingerprint;
  }
  
  // Expose function để extension có thể gọi
  window.__getCanvasFingerprint = getCanvasFingerprint;
  window.__rotateCanvasFingerprint = rotateCanvasFingerprint;
  
  // Listen for rotate event từ extension
  window.addEventListener('rotateCanvasFingerprint', function() {
    rotateCanvasFingerprint();
  });
  
  // Override toDataURL
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    const original = originalToDataURL.apply(this, arguments);
    
    // Chỉ fake khi detect fingerprinting attempt
    if (this.width > 16 || this.height > 16) {
      // Inject noise vào canvas
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;
        const noise = getCanvasFingerprint();
        
        // Thêm noise nhỏ vào một vài pixel (không quá nhiều để tránh phát hiện)
        for (let i = 0; i < data.length; i += 4) {
          if (Math.random() < 0.01) { // Chỉ 1% pixels
            data[i] = (data[i] + (noise % 10)) % 256;
            data[i + 1] = (data[i + 1] + (noise % 7)) % 256;
            data[i + 2] = (data[i + 2] + (noise % 5)) % 256;
          }
        }
        ctx.putImageData(imageData, 0, 0);
      }
    }
    
    return originalToDataURL.apply(this, arguments);
  };
  
  // Override toBlob
  HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
    const original = originalToBlob.apply(this, arguments);
    
    if (this.width > 16 || this.height > 16) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        const data = imageData.data;
        const noise = getCanvasFingerprint();
        
        for (let i = 0; i < data.length; i += 4) {
          if (Math.random() < 0.01) {
            data[i] = (data[i] + (noise % 10)) % 256;
            data[i + 1] = (data[i + 1] + (noise % 7)) % 256;
            data[i + 2] = (data[i + 2] + (noise % 5)) % 256;
          }
        }
        ctx.putImageData(imageData, 0, 0);
      }
    }
    
    return originalToBlob.apply(this, arguments);
  };
  
  // ============================================
  // 2. WEBGL FINGERPRINTING PROTECTION
  // ============================================
  
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  const originalGetParameterWebGL2 = WebGL2RenderingContext?.prototype?.getParameter;
  
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    // Fake một số WebGL parameters
    if (parameter === this.VENDOR) {
      return 'Google Inc. (Intel)';
    }
    if (parameter === this.RENDERER) {
      return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    }
    return originalGetParameter.apply(this, arguments);
  };
  
  if (WebGL2RenderingContext) {
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === this.VENDOR) {
        return 'Google Inc. (Intel)';
      }
      if (parameter === this.RENDERER) {
        return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      }
      return originalGetParameterWebGL2.apply(this, arguments);
    };
  }
  
  // ============================================
  // 3. AUDIO FINGERPRINTING PROTECTION
  // ============================================
  
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) {
    const originalCreateOscillator = AudioContext.prototype.createOscillator;
    const originalCreateDynamicsCompressor = AudioContext.prototype.createDynamicsCompressor;
    
    // Inject noise vào audio context
    AudioContext.prototype.createOscillator = function() {
      const oscillator = originalCreateOscillator.apply(this, arguments);
      const originalStart = oscillator.start;
      
      oscillator.start = function(when) {
        // Thêm delay nhỏ để fake fingerprint
        const noise = Math.random() * 0.0001;
        return originalStart.apply(this, [when + noise]);
      };
      
      return oscillator;
    };
  }
  
  // ============================================
  // 4. FONT FINGERPRINTING PROTECTION
  // ============================================
  
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')?.get;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get;
  
  // Fake font measurements (optional, có thể gây lỗi layout)
  // Chỉ nên dùng khi cần thiết
  
  // ============================================
  // 5. NAVIGATOR HARDWARE PROPERTIES PROTECTION
  // ============================================
  
  // Generate consistent hardware fingerprint (có thể rotate)
  let hardwareFingerprint = null;
  function getHardwareFingerprint() {
    if (!hardwareFingerprint) {
      // Tạo fingerprint ngẫu nhiên nhưng consistent trong session
      hardwareFingerprint = {
        cores: [4, 8, 12, 16][Math.floor(Math.random() * 4)], // Common CPU core counts
        memory: [4, 8, 16][Math.floor(Math.random() * 3)] // Common RAM sizes (GB)
      };
    }
    return hardwareFingerprint;
  }
  
  // Function để rotate hardware fingerprint (gọi từ extension)
  function rotateHardwareFingerprint() {
    const oldFingerprint = hardwareFingerprint;
    hardwareFingerprint = {
      cores: [4, 8, 12, 16][Math.floor(Math.random() * 4)],
      memory: [4, 8, 16][Math.floor(Math.random() * 3)]
    };
    console.log(`[Fingerprint Protection] 🔄 Hardware fingerprint rotated: cores ${oldFingerprint?.cores}→${hardwareFingerprint.cores}, memory ${oldFingerprint?.memory}→${hardwareFingerprint.memory}GB`);
    return hardwareFingerprint;
  }
  
  // Expose function để extension có thể gọi
  window.__getHardwareFingerprint = getHardwareFingerprint;
  window.__rotateHardwareFingerprint = rotateHardwareFingerprint;
  
  // Listen for rotate event từ extension
  window.addEventListener('rotateHardwareFingerprint', function() {
    rotateHardwareFingerprint();
  });
  
  // Fake navigator.hardwareConcurrency (CPU cores)
  if (navigator.hardwareConcurrency !== undefined) {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: function() {
        const hw = getHardwareFingerprint();
        return hw.cores;
      },
      configurable: true
    });
  }
  
  // Fake navigator.deviceMemory (RAM in GB)
  if (navigator.deviceMemory !== undefined) {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function() {
        const hw = getHardwareFingerprint();
        return hw.memory;
      },
      configurable: true
    });
  }
  
  // ============================================
  // 6. SCREEN PROPERTIES PROTECTION
  // ============================================
  
  // Generate consistent screen fingerprint
  let screenFingerprint = null;
  function getScreenFingerprint() {
    if (!screenFingerprint) {
      // Color depth thường là 24 (true color) hoặc 30 (10-bit color)
      screenFingerprint = {
        colorDepth: 24 // Standard true color
      };
    }
    return screenFingerprint;
  }
  
  // Function để rotate screen fingerprint (gọi từ extension)
  function rotateScreenFingerprint() {
    const oldFingerprint = screenFingerprint;
    screenFingerprint = {
      colorDepth: 24 // Giữ 24 vì là standard, có thể đổi thành 30 nếu muốn
    };
    console.log(`[Fingerprint Protection] 🔄 Screen fingerprint rotated: colorDepth ${oldFingerprint?.colorDepth}→${screenFingerprint.colorDepth}`);
    return screenFingerprint;
  }
  
  // Expose function để extension có thể gọi
  window.__getScreenFingerprint = getScreenFingerprint;
  window.__rotateScreenFingerprint = rotateScreenFingerprint;
  
  // Listen for rotate event từ extension
  window.addEventListener('rotateScreenFingerprint', function() {
    rotateScreenFingerprint();
  });
  
  // Fake screen.colorDepth
  if (screen.colorDepth !== undefined) {
    Object.defineProperty(screen, 'colorDepth', {
      get: function() {
        const sf = getScreenFingerprint();
        return sf.colorDepth;
      },
      configurable: true
    });
  }
  
  // Fake screen.pixelDepth (thường giống colorDepth)
  if (screen.pixelDepth !== undefined) {
    Object.defineProperty(screen, 'pixelDepth', {
      get: function() {
        const sf = getScreenFingerprint();
        return sf.colorDepth; // pixelDepth thường giống colorDepth
      },
      configurable: true
    });
  }
  
  // Screen resolution - giữ nguyên (khó fake mà không ảnh hưởng UX)
  // Timezone - giữ nguyên (cần thiết cho functionality)
  
  // ============================================
  // 7. NETWORK CONNECTION INFO PROTECTION
  // ============================================
  
  // Generate consistent connection fingerprint
  let connectionFingerprint = null;
  function getConnectionFingerprint() {
    if (!connectionFingerprint) {
      // Fake connection properties hợp lý
      connectionFingerprint = {
        effectiveType: '4g', // 'slow-2g', '2g', '3g', '4g'
        downlink: 5 + Math.random() * 45, // 5-50 Mbps (random nhưng consistent)
        rtt: 50 + Math.random() * 150, // 50-200ms (random nhưng consistent)
        saveData: false
      };
    }
    return connectionFingerprint;
  }
  
  // Function để rotate connection fingerprint (gọi từ extension)
  function rotateConnectionFingerprint() {
    const oldFingerprint = connectionFingerprint;
    connectionFingerprint = {
      effectiveType: '4g',
      downlink: 5 + Math.random() * 45,
      rtt: 50 + Math.random() * 150,
      saveData: false
    };
    console.log(`[Fingerprint Protection] 🔄 Connection fingerprint rotated: effectiveType ${oldFingerprint?.effectiveType}→${connectionFingerprint.effectiveType}, downlink ${oldFingerprint?.downlink?.toFixed(2)}→${connectionFingerprint.downlink.toFixed(2)}Mbps`);
    return connectionFingerprint;
  }
  
  // Expose function để extension có thể gọi
  window.__getConnectionFingerprint = getConnectionFingerprint;
  window.__rotateConnectionFingerprint = rotateConnectionFingerprint;
  
  // Listen for rotate event từ extension
  window.addEventListener('rotateConnectionFingerprint', function() {
    rotateConnectionFingerprint();
  });
  
  // Fake navigator.connection (Network Information API)
  if (navigator.connection || navigator.mozConnection || navigator.webkitConnection) {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    
    if (connection) {
      const cf = getConnectionFingerprint();
      
      // Fake effectiveType
      if (connection.effectiveType !== undefined) {
        Object.defineProperty(connection, 'effectiveType', {
          get: function() {
            const conn = getConnectionFingerprint();
            return conn.effectiveType;
          },
          configurable: true
        });
      }
      
      // Fake downlink (Mbps)
      if (connection.downlink !== undefined) {
        Object.defineProperty(connection, 'downlink', {
          get: function() {
            const conn = getConnectionFingerprint();
            return conn.downlink;
          },
          configurable: true
        });
      }
      
      // Fake rtt (round-trip time in ms)
      if (connection.rtt !== undefined) {
        Object.defineProperty(connection, 'rtt', {
          get: function() {
            const conn = getConnectionFingerprint();
            return conn.rtt;
          },
          configurable: true
        });
      }
      
      // Fake saveData
      if (connection.saveData !== undefined) {
        Object.defineProperty(connection, 'saveData', {
          get: function() {
            const conn = getConnectionFingerprint();
            return conn.saveData;
          },
          configurable: true
        });
      }
    }
  }
  
  // ============================================
  // 8. PLUGINS FINGERPRINTING
  // ============================================
  
  // Fake navigator.plugins
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      // Trả về plugins giống Chrome thật
      const fakePlugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ];
      return fakePlugins;
    }
  });
  
  // ============================================
  // 9. WEBRTC LEAK PROTECTION (nếu cần)
  // ============================================
  
  const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (RTCPeerConnection) {
    const originalCreateOffer = RTCPeerConnection.prototype.createOffer;
    RTCPeerConnection.prototype.createOffer = function() {
      return originalCreateOffer.apply(this, arguments).then(offer => {
        // Remove IP leaks từ SDP
        offer.sdp = offer.sdp.replace(/a=candidate:.*\r\n/g, '');
        return offer;
      });
    };
  }
  
  console.log('[Fingerprint Protection] ✅ Anti-fingerprinting enabled');
})();

