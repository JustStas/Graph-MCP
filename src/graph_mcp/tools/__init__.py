from graph_mcp.tools.auth_tools import register_auth_tools
from graph_mcp.tools.profile_tools import register_profile_tools
from graph_mcp.tools.chat_tools import register_chat_tools
from graph_mcp.tools.teams_tools import register_teams_tools
from graph_mcp.tools.calendar_tools import register_calendar_tools
from graph_mcp.tools.mail_tools import register_mail_tools
from graph_mcp.tools.user_tools import register_user_tools
from graph_mcp.tools.presence_tools import register_presence_tools
from graph_mcp.tools.search_tools import register_search_tools


def register_all_tools(mcp):
    register_auth_tools(mcp)
    register_profile_tools(mcp)
    register_chat_tools(mcp)
    register_teams_tools(mcp)
    register_calendar_tools(mcp)
    register_mail_tools(mcp)
    register_user_tools(mcp)
    register_presence_tools(mcp)
    register_search_tools(mcp)
