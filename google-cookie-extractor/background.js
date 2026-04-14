const GROK_URL_PATTERN = "*://grok.com/*"
const GROK_WWW_URL_PATTERN = "*://www.grok.com/*"
const GROK_STORAGE_KEY = "grokHeaderCookies"

function parseCookieHeader(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=")
      if (separatorIndex === -1) {
        return null
      }

      const name = part.slice(0, separatorIndex).trim()
      const value = part.slice(separatorIndex + 1).trim()

      if (!name) {
        return null
      }

      return { name, value }
    })
    .filter(Boolean)
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    const cookieHeader = details.requestHeaders?.find((header) => header.name.toLowerCase() === "cookie")

    if (!cookieHeader?.value) {
      return
    }

    const cookies = parseCookieHeader(cookieHeader.value)
    if (cookies.length === 0) {
      return
    }

    await chrome.storage.local.set({
      [GROK_STORAGE_KEY]: {
        url: details.url,
        cookies,
        cookieHeader: cookieHeader.value,
        updatedAt: Date.now()
      }
    })
  },
  {
    urls: [GROK_URL_PATTERN, GROK_WWW_URL_PATTERN]
  },
  ["requestHeaders", "extraHeaders"]
)
