"""Workflow engine — executes a node-graph workflow definition."""
from __future__ import annotations

import asyncio
from typing import Any

from services import job_store
from services.workflow.node_registry import get_handler


class WorkflowRunner:
    """
    Workflow graph format:
    {
        "nodes": [
            {"id": "n1", "type": "text", "config": {"text": "..."}, "label": "Input"},
            {"id": "n2", "type": "text_to_video", "config": {...}, "label": "T2V"},
        ],
        "edges": [
            {"from": "n1", "to": "n2", "from_key": "text", "to_key": "prompt"}
        ]
    }
    """

    async def run(
        self,
        workflow: dict,
        job_id: str,
        run_to_node_id: str | None = None,
    ):
        try:
            await job_store.update_job(job_id, status="running", progress=0)
            nodes: list[dict] = workflow.get("nodes", [])
            edges: list[dict] = workflow.get("edges", [])

            if not nodes:
                await job_store.update_job(job_id, status="failed", error="Workflow không có nodes")
                return

            # Build adjacency: node_id -> list of (source_node_id, from_key, to_key)
            incoming: dict[str, list[tuple[str, str, str]]] = {n["id"]: [] for n in nodes}
            for e in edges:
                to_id = e.get("to")
                from_id = e.get("from")
                from_key = e.get("from_key", "")
                to_key = e.get("to_key", "prompt")
                if to_id and from_id:
                    incoming[to_id].append((from_id, from_key, to_key))

            # Topological sort
            order = self._topo_sort(nodes, edges)

            node_outputs: dict[str, dict] = {}
            total = len(order)

            for i, node_id in enumerate(order):
                node = next((n for n in nodes if n["id"] == node_id), None)
                if not node:
                    continue

                # Build context from predecessors
                ctx: dict[str, Any] = {}
                for (src_id, from_key, to_key) in incoming.get(node_id, []):
                    src_out = node_outputs.get(src_id, {})
                    if from_key:
                        ctx[to_key] = src_out.get(from_key, "")
                    else:
                        ctx.update(src_out)

                node_type = node.get("type", "")
                node_cfg = node.get("config", {})
                handler = get_handler(node_type)
                if not handler:
                    node_outputs[node_id] = {"error": f"Unknown node type: {node_type}"}
                else:
                    try:
                        result = await handler(node_cfg, ctx)
                        node_outputs[node_id] = result
                    except Exception as e:
                        node_outputs[node_id] = {"error": str(e)}

                progress = int((i + 1) / total * 100)
                await job_store.update_job(
                    job_id,
                    progress=progress,
                    outputs={"node_outputs": node_outputs},
                )

                if run_to_node_id and node_id == run_to_node_id:
                    break

            await job_store.update_job(
                job_id,
                status="done",
                progress=100,
                outputs={"node_outputs": node_outputs},
            )
        except Exception as e:
            await job_store.update_job(job_id, status="failed", error=str(e))

    def _topo_sort(self, nodes: list[dict], edges: list[dict]) -> list[str]:
        """Kahn's algorithm topological sort."""
        node_ids = [n["id"] for n in nodes]
        in_degree: dict[str, int] = {nid: 0 for nid in node_ids}
        adj: dict[str, list[str]] = {nid: [] for nid in node_ids}
        for e in edges:
            src = e.get("from")
            dst = e.get("to")
            if src in adj and dst in in_degree:
                adj[src].append(dst)
                in_degree[dst] += 1

        queue = [nid for nid in node_ids if in_degree[nid] == 0]
        result = []
        while queue:
            nid = queue.pop(0)
            result.append(nid)
            for neighbor in adj.get(nid, []):
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        # Append any remaining (cycle detection — just append rest)
        remaining = [nid for nid in node_ids if nid not in result]
        result.extend(remaining)
        return result
