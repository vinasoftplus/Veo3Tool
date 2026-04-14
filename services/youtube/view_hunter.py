"""YouTube View Hunter — searches videos by keyword using YouTube Data API v3."""
from __future__ import annotations

import asyncio
from typing import Any


class ViewHunterService:
    BASE_URL = "https://www.googleapis.com/youtube/v3"

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(
        self,
        keyword: str,
        region_code: str | None = None,
        order: str = "viewCount",
        published_after: str | None = None,
        max_results: int = 50,
    ) -> list[dict[str, Any]]:
        import urllib.request
        import urllib.parse
        import json

        params: dict[str, str] = {
            "part": "snippet",
            "q": keyword,
            "type": "video",
            "order": order,
            "maxResults": str(min(max_results, 50)),
            "key": self.api_key,
        }
        if region_code:
            params["regionCode"] = region_code
        if published_after:
            params["publishedAfter"] = published_after

        search_url = f"{self.BASE_URL}/search?" + urllib.parse.urlencode(params)

        def _fetch_search():
            with urllib.request.urlopen(search_url, timeout=15) as r:
                return json.loads(r.read())

        data = await asyncio.to_thread(_fetch_search)
        items = data.get("items", [])
        video_ids = [it["id"]["videoId"] for it in items if it.get("id", {}).get("videoId")]

        if not video_ids:
            return []

        # Fetch statistics
        stats_url = (
            f"{self.BASE_URL}/videos?part=statistics,contentDetails"
            f"&id={','.join(video_ids)}&key={self.api_key}"
        )

        def _fetch_stats():
            with urllib.request.urlopen(stats_url, timeout=15) as r:
                return json.loads(r.read())

        stats_data = await asyncio.to_thread(_fetch_stats)
        stats_map: dict[str, dict] = {}
        for it in stats_data.get("items", []):
            stats_map[it["id"]] = {
                "viewCount": int(it.get("statistics", {}).get("viewCount", 0)),
                "likeCount": int(it.get("statistics", {}).get("likeCount", 0)),
                "commentCount": int(it.get("statistics", {}).get("commentCount", 0)),
                "duration": it.get("contentDetails", {}).get("duration", ""),
            }

        results = []
        for it in items:
            vid_id = it.get("id", {}).get("videoId", "")
            snippet = it.get("snippet", {})
            stats = stats_map.get(vid_id, {})
            results.append({
                "videoId": vid_id,
                "title": snippet.get("title", ""),
                "channelTitle": snippet.get("channelTitle", ""),
                "publishedAt": snippet.get("publishedAt", ""),
                "thumbnail": snippet.get("thumbnails", {}).get("medium", {}).get("url", ""),
                "url": f"https://www.youtube.com/watch?v={vid_id}",
                **stats,
            })

        results.sort(key=lambda x: x.get("viewCount", 0), reverse=True)
        return results
