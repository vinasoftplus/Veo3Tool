class SimpleCookieExtractor {
  constructor() {
    this.googleCookies = []
    this.grokCookies = []
    this.googleDomains = ["google.com", "accounts.google.com"]
    this.grokTargets = [{ domain: "grok.com", url: "https://grok.com/" }]
    this.requiredGrokCookieNames = [
      "_ga",
      "i18nextLng",
      "_twpid",
      "cf_clearance",
      "sso",
      "sso-rw",
      "x-userid",
      "mp_ea93da913ddb66b6372b89d97b1029ac_mixpanel",
      "__cf_bm",
      "_ga_8FEWB057YH"
    ]
    this.grokHeaderStorageKey = "grokHeaderCookies"
    this.initializeEventListeners()

    // Auto load cookies when popup opens
    this.loadCookiesForSection({
      buttonId: "loadBtn",
      textareaId: "cookiesTextarea",
      domains: this.googleDomains,
      cookiesKey: "googleCookies"
    })
  }

  initializeEventListeners() {
    document.getElementById("loadBtn").addEventListener("click", () => {
      this.loadCookiesForSection({
        buttonId: "loadBtn",
        textareaId: "cookiesTextarea",
        domains: this.googleDomains,
        cookiesKey: "googleCookies"
      })
    })

    document.getElementById("copyBtn").addEventListener("click", () => {
      this.copyCookies("cookiesTextarea", "copyBtn", "Không có Google cookies nào được tìm thấy.")
    })

    document.getElementById("loadGrokBtn").addEventListener("click", async () => {
      await this.loadGrokCookiesFromActiveTab()
    })

    document.getElementById("copyGrokBtn").addEventListener("click", () => {
      this.copyCookies("grokCookiesTextarea", "copyGrokBtn", "Không có Grok cookies nào được tìm thấy.")
    })
  }

  async loadCookiesForSection({ buttonId, textareaId, domains, targets, cookiesKey }) {
    const loadBtn = document.getElementById(buttonId)
    const originalText = loadBtn.textContent

    try {
      loadBtn.textContent = "Loading..."
      loadBtn.style.background = "#f59e0b"
      loadBtn.disabled = true

      const allCookies = []

      const cookieTargets = targets || (domains || []).map((domain) => ({ domain }))

      for (const target of cookieTargets) {
        const { domain, url } = target

        if (url) {
          const urlCookies = await chrome.cookies.getAll({ url })
          const matchedUrl = new URL(url)
          const domainCookies = urlCookies.filter((cookie) => {
            const normalizedCookieDomain = cookie.domain.replace(/^\./, "")
            return normalizedCookieDomain === domain || normalizedCookieDomain === matchedUrl.hostname.replace(/^www\./, "")
          })

          allCookies.push(...domainCookies)
          continue
        }

        const exactCookies = await chrome.cookies.getAll({ domain })
        const dotCookies = await chrome.cookies.getAll({ domain: "." + domain })

        const domainCookies = [...exactCookies, ...dotCookies].filter((cookie) => {
          return cookie.domain === domain || cookie.domain === "." + domain || cookie.domain === "www." + domain
        })

        allCookies.push(...domainCookies)
      }

      this[cookiesKey] = this.removeDuplicates(allCookies)
      this.displayCookies(textareaId, this[cookiesKey], this.getEmptyMessage(cookiesKey), cookiesKey)

      loadBtn.textContent = "Loaded"
      loadBtn.style.background = "#10b981"
      loadBtn.disabled = false

      setTimeout(() => {
        loadBtn.textContent = originalText
        loadBtn.style.background = "#3b82f6"
      }, 2000)
    } catch (error) {
      console.error("Error loading cookies:", error)
      loadBtn.textContent = originalText
      loadBtn.style.background = "#3b82f6"
      loadBtn.disabled = false
    }
  }

  async loadGrokCookiesFromActiveTab() {
    const textarea = document.getElementById("grokCookiesTextarea")
    const loadBtn = document.getElementById("loadGrokBtn")
    const originalText = loadBtn.textContent

    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })

      if (!activeTab || !activeTab.url) {
        textarea.value = "Không tìm thấy tab đang mở. Hãy mở https://grok.com/ rồi thử lại."
        return
      }

      const currentUrl = new URL(activeTab.url)
      if (currentUrl.hostname !== "grok.com" && currentUrl.hostname !== "www.grok.com") {
        textarea.value = "Hãy mở sẵn tab https://grok.com/ rồi bấm lại để quét cookie chuẩn theo tab hiện tại."
        return
      }

      loadBtn.textContent = "Scanning..."
      loadBtn.style.background = "#f59e0b"
      loadBtn.disabled = true

      this.grokTargets = [{ domain: currentUrl.hostname.replace(/^www\./, ""), url: activeTab.url }]

      const storageResult = await chrome.storage.local.get(this.grokHeaderStorageKey)
      const headerSnapshot = storageResult[this.grokHeaderStorageKey]
      const headerCookies = this.extractHeaderCookiesForUrl(headerSnapshot, currentUrl)

      if (headerCookies.length > 0) {
        this.grokCookies = this.removeDuplicates(headerCookies)
        this.displayCookies("grokCookiesTextarea", this.grokCookies, this.getEmptyMessage("grokCookies"), "grokCookies")
      } else {
        await this.loadCookiesForSection({
          buttonId: "loadGrokBtn",
          textareaId: "grokCookiesTextarea",
          targets: this.grokTargets,
          cookiesKey: "grokCookies"
        })
      }

      loadBtn.textContent = "Loaded"
      loadBtn.style.background = "#10b981"
      loadBtn.disabled = false

      setTimeout(() => {
        loadBtn.textContent = originalText
        loadBtn.style.background = "#3b82f6"
      }, 2000)
    } catch (error) {
      console.error("Error locating Grok tab:", error)
      textarea.value = "Không thể đọc tab Grok hiện tại. Hãy reload tab Grok rồi thử lại."
      loadBtn.textContent = originalText
      loadBtn.style.background = "#3b82f6"
      loadBtn.disabled = false
    }
  }

  extractHeaderCookiesForUrl(headerSnapshot, currentUrl) {
    if (!headerSnapshot || !headerSnapshot.url || !Array.isArray(headerSnapshot.cookies)) {
      return []
    }

    const snapshotUrl = new URL(headerSnapshot.url)
    const normalizedCurrentHost = currentUrl.hostname.replace(/^www\./, "")
    const normalizedSnapshotHost = snapshotUrl.hostname.replace(/^www\./, "")

    if (normalizedCurrentHost !== normalizedSnapshotHost) {
      return []
    }

    return headerSnapshot.cookies.filter((cookie) => typeof cookie.name === "string" && typeof cookie.value === "string")
  }

  getEmptyMessage(cookiesKey) {
    if (cookiesKey === "grokCookies") {
      return "Không có Grok cookies nào được tìm thấy."
    }

    return "Không có Google cookies nào được tìm thấy."
  }

  removeDuplicates(cookies) {
    const seen = new Set()
    return cookies.filter((cookie) => {
      const key = `${cookie.name}-${cookie.domain}-${cookie.path}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }

  displayCookies(textareaId, cookies, emptyMessage, cookiesKey) {
    const textarea = document.getElementById(textareaId)

    if (cookies.length === 0) {
      textarea.value = emptyMessage
      return
    }

    if (cookiesKey === "grokCookies") {
      const missingCookies = this.getMissingRequiredCookies(cookies, this.requiredGrokCookieNames)

      if (missingCookies.length > 0) {
        textarea.value = [
          "Cookie Grok chưa đủ.",
          "Thiếu: " + missingCookies.join(", "),
          "Vui lòng xóa sạch cache/cookies của grok.com rồi đăng nhập lại để lấy đủ cookie."
        ].join("\n")
        return
      }
    }

    const cookieString = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
    textarea.value = cookieString
  }

  getMissingRequiredCookies(cookies, requiredCookieNames) {
    const existingCookieNames = new Set(cookies.map((cookie) => cookie.name))
    return requiredCookieNames.filter((cookieName) => !existingCookieNames.has(cookieName))
  }

  async copyCookies(textareaId, buttonId, emptyMessage) {
    const textarea = document.getElementById(textareaId)
    const cookieText = textarea.value.trim()
    const copyBtn = document.getElementById(buttonId)

    if (!cookieText || cookieText === emptyMessage || cookieText.startsWith("Cookie Grok chưa đủ.")) {
      return
    }

    const originalText = copyBtn.textContent

    try {
      await navigator.clipboard.writeText(cookieText)
      copyBtn.textContent = "Copied"
      copyBtn.style.background = "#10b981"

      setTimeout(() => {
        copyBtn.textContent = originalText
        copyBtn.style.background = "#3b82f6"
      }, 2000)
    } catch (error) {
      console.error("Error copying cookies:", error)
      textarea.select()
      textarea.setSelectionRange(0, 99999)

      try {
        document.execCommand("copy")
        copyBtn.textContent = "Copied"
        copyBtn.style.background = "#10b981"

        setTimeout(() => {
          copyBtn.textContent = originalText
          copyBtn.style.background = "#3b82f6"
        }, 2000)
      } catch (fallbackError) {
        // Silent fail
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new SimpleCookieExtractor()
})
