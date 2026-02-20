from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response


def register_search_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_search_messages(query: str, top: int = 25) -> str:
        """Search messages across Teams chats and channels.

        Args:
            query: Search query string.
            top: Maximum number of results (default 25).
        """
        body = {
            "requests": [
                {
                    "entityTypes": ["chatMessage"],
                    "query": {"queryString": query},
                    "from": 0,
                    "size": min(top, 25),
                }
            ]
        }
        result = await graph_client.post("/search/query", json_body=body)

        hits = []
        for response in result.get("value", []):
            for hit_container in response.get("hitsContainers", []):
                for hit in hit_container.get("hits", []):
                    hits.append(hit.get("resource", hit))

        return success_response(hits)
