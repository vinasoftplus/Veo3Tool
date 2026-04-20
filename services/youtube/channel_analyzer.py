"""YouTube Channel Analyzer — channel info, YPP eligibility, hashtags, top videos."""
from __future__ import annotations

import asyncio
import json
import re
import urllib.parse
import urllib.request
from collections import Counter
from typing import Any


class ChannelAnalyzerService:
    BASE = "https://www.googleapis.com/youtube/v3"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def _get(self, endpoint: str, params: dict) -> dict:
        params["key"] = self.api_key
        url = f"{self.BASE}/{endpoint}?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.loads(r.read())

    async def _fetch(self, endpoint: str, params: dict) -> dict:
        return await asyncio.to_thread(self._get, endpoint, params)

    # ------------------------------------------------------------------
    # Resolve channel URL → channel ID
    # ------------------------------------------------------------------
    async def _resolve_channel_id(self, url: str) -> str:
        url = url.strip().rstrip("/")

        # Already a bare channel ID
        if re.match(r'^UC[\w-]{21,}$', url):
            return url

        # Extract from URL patterns
        m = re.search(r'/channel/(UC[\w-]{21,})', url)
        if m:
            return m.group(1)

        # @handle or /c/name or /user/name
        handle_m = re.search(r'/@([\w.%-]+)', url)
        slug_m = re.search(r'/(?:c|user)/([\w.%-]+)', url)
        handle = (handle_m or slug_m)

        if handle:
            name = handle.group(1)
            # Try forHandle first (handles @username)
            data = await self._fetch("channels", {"part": "id", "forHandle": "@" + name.lstrip("@")})
            if data.get("items"):
                return data["items"][0]["id"]
            # Fallback: forUsername
            data = await self._fetch("channels", {"part": "id", "forUsername": name})
            if data.get("items"):
                return data["items"][0]["id"]

        # Maybe it's a video URL — extract channel from video
        vid_m = re.search(r'[?&]v=([\w-]{11})', url)
        if vid_m:
            data = await self._fetch("videos", {"part": "snippet", "id": vid_m.group(1)})
            if data.get("items"):
                return data["items"][0]["snippet"]["channelId"]

        raise ValueError(f"Không thể xác định channel từ URL: {url}")

    # ------------------------------------------------------------------
    # Main analyze
    # ------------------------------------------------------------------
    async def analyze(self, channel_url: str, max_videos: int = 30) -> dict[str, Any]:
        channel_id = await self._resolve_channel_id(channel_url)

        # Channel info
        ch_data = await self._fetch("channels", {
            "part": "snippet,statistics,brandingSettings",
            "id": channel_id,
        })
        if not ch_data.get("items"):
            raise ValueError("Không tìm thấy kênh")

        ch = ch_data["items"][0]
        snippet = ch.get("snippet", {})
        stats = ch.get("statistics", {})

        sub_count = int(stats.get("subscriberCount", 0))
        view_count = int(stats.get("viewCount", 0))
        video_count = int(stats.get("videoCount", 0))
        hidden_subs = stats.get("hiddenSubscriberCount", False)

        channel_info = {
            "id": channel_id,
            "title": snippet.get("title", ""),
            "description": snippet.get("description", ""),
            "country": snippet.get("country", ""),
            "published_at": snippet.get("publishedAt", ""),
            "thumbnail": snippet.get("thumbnails", {}).get("medium", {}).get("url", ""),
            "custom_url": snippet.get("customUrl", ""),
            "subscriber_count": sub_count,
            "hidden_subs": hidden_subs,
            "view_count": view_count,
            "video_count": video_count,
        }

        # YPP eligibility
        ypp = {
            "eligible": sub_count >= 1000 and video_count >= 1,
            "sub_ok": sub_count >= 1000,
            "sub_count": sub_count,
            "note": "Đủ điều kiện sub (≥1000)" if sub_count >= 1000 else f"Thiếu {1000 - sub_count} sub",
        }

        # Get uploads playlist ID
        uploads_playlist = ch.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads", "")
        # Fetch via search instead (contentDetails not requested above — simpler)
        # Get recent videos via search
        search_data = await self._fetch("search", {
            "part": "snippet",
            "channelId": channel_id,
            "order": "date",
            "type": "video",
            "maxResults": min(max_videos, 50),
        })

        video_ids = [
            it["id"]["videoId"]
            for it in search_data.get("items", [])
            if it.get("id", {}).get("videoId")
        ]

        videos = []
        hashtag_counter: Counter = Counter()

        if video_ids:
            # Fetch stats + snippet (tags, description) for all videos
            vid_data = await self._fetch("videos", {
                "part": "snippet,statistics,contentDetails",
                "id": ",".join(video_ids),
            })

            def _parse_duration(s: str) -> str:
                m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', s or "")
                if not m:
                    return s
                h, mn, sc = m.group(1) or 0, m.group(2) or 0, m.group(3) or 0
                return (f"{h}:{str(mn).zfill(2)}:{str(sc).zfill(2)}"
                        if int(h) else f"{mn}:{str(sc).zfill(2)}")

            for it in vid_data.get("items", []):
                vs = it.get("snippet", {})
                vst = it.get("statistics", {})
                tags = vs.get("tags") or []
                desc = vs.get("description", "")

                # Count tags
                for t in tags:
                    hashtag_counter[t.lower()] += 1

                # Parse #hashtags from description
                for ht in re.findall(r'#([\w\u00C0-\u024F\u1E00-\u1EFF]+)', desc):
                    hashtag_counter[ht.lower()] += 1

                videos.append({
                    "videoId": it["id"],
                    "title": vs.get("title", ""),
                    "publishedAt": vs.get("publishedAt", ""),
                    "thumbnail": vs.get("thumbnails", {}).get("medium", {}).get("url", ""),
                    "url": f"https://www.youtube.com/watch?v={it['id']}",
                    "viewCount": int(vst.get("viewCount", 0)),
                    "likeCount": int(vst.get("likeCount", 0)),
                    "commentCount": int(vst.get("commentCount", 0)),
                    "duration": _parse_duration(it.get("contentDetails", {}).get("duration", "")),
                })

            videos.sort(key=lambda x: x["viewCount"], reverse=True)

        top_hashtags = [
            {"tag": tag, "count": cnt}
            for tag, cnt in hashtag_counter.most_common(30)
        ]

        return {
            "channel": channel_info,
            "ypp": ypp,
            "top_hashtags": top_hashtags,
            "videos": videos,
        }
