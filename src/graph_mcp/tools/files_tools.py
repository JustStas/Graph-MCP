import base64

from graph_mcp.graph_client import graph_client
from graph_mcp.responses import require_auth, success_response

DRIVE_ITEM_FIELDS = (
    "id,name,size,createdDateTime,lastModifiedDateTime,"
    "file,folder,webUrl,parentReference"
)


def register_files_tools(mcp):
    @mcp.tool()
    @require_auth
    async def graph_list_files(
        folder_id: str = "", top: int = 25
    ) -> str:
        """List files and folders in OneDrive.

        Args:
            folder_id: Folder ID to list contents of. Empty for root folder.
            top: Maximum number of items to return (default 25).
        """
        if folder_id:
            path = f"/me/drive/items/{folder_id}/children"
        else:
            path = "/me/drive/root/children"

        result = await graph_client.get(
            path,
            params={
                "$select": DRIVE_ITEM_FIELDS,
                "$top": str(min(top, 50)),
            },
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_search_files(query: str, top: int = 25) -> str:
        """Search for files in OneDrive by name or content.

        Args:
            query: Search query string.
            top: Maximum number of results (default 25).
        """
        result = await graph_client.get(
            f"/me/drive/root/search(q='{query}')",
            params={
                "$select": DRIVE_ITEM_FIELDS,
                "$top": str(min(top, 25)),
            },
        )
        return success_response(result.get("value", []))

    @mcp.tool()
    @require_auth
    async def graph_get_file_content(file_id: str) -> str:
        """Get the content of a file from OneDrive.

        For text-based files (txt, csv, json, etc.), returns the file content
        directly. For binary files (images, docx, pdf, etc.), returns a
        temporary download URL instead.

        Args:
            file_id: The file ID (from graph_list_files or graph_search_files).
        """
        # First get metadata to check file type
        metadata = await graph_client.get(
            f"/me/drive/items/{file_id}",
            params={"$select": "id,name,size,file,@microsoft.graph.downloadUrl"},
        )

        # For binary files, return the download URL
        mime = metadata.get("file", {}).get("mimeType", "")
        text_types = (
            "text/", "application/json", "application/xml",
            "application/javascript", "application/csv",
        )
        is_text = any(mime.startswith(t) for t in text_types)

        if not is_text:
            return success_response({
                "name": metadata.get("name"),
                "mimeType": mime,
                "size": metadata.get("size"),
                "downloadUrl": metadata.get("@microsoft.graph.downloadUrl", ""),
                "note": "Binary file — use the downloadUrl to access content.",
            })

        # For text files, fetch the actual content
        content = await graph_client.get(f"/me/drive/items/{file_id}/content")
        return success_response({
            "name": metadata.get("name"),
            "mimeType": mime,
            "content": content,
        })

    @mcp.tool()
    @require_auth
    async def graph_upload_file(
        file_path: str, content_base64: str
    ) -> str:
        """Upload a small file to OneDrive (max 4MB).

        Args:
            file_path: Destination path in OneDrive (e.g. "Documents/report.txt").
            content_base64: File content encoded as base64 string.
        """
        file_bytes = base64.b64decode(content_base64)
        if len(file_bytes) > 4 * 1024 * 1024:
            return success_response(
                {"error": "File too large. Maximum upload size is 4MB."},
                message="error",
            )

        result = await graph_client.put(
            f"/me/drive/root:/{file_path}:/content",
            data=file_bytes,
            headers={"Content-Type": "application/octet-stream"},
        )
        return success_response(result)

    @mcp.tool()
    @require_auth
    async def graph_share_file(
        file_id: str,
        share_type: str = "view",
        scope: str = "organization",
    ) -> str:
        """Create a sharing link for a OneDrive file.

        Args:
            file_id: The file ID to share.
            share_type: Permission type: "view", "edit", or "embed" (default "view").
            scope: Share scope: "anonymous", "organization", or "users" (default "organization").
        """
        body = {"type": share_type, "scope": scope}
        result = await graph_client.post(
            f"/me/drive/items/{file_id}/createLink",
            json_body=body,
        )
        return success_response(result)
