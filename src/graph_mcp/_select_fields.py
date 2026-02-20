"""$select field constants for Graph API resource types."""

EVENT_LIST_FIELDS = (
    "id,subject,start,end,location,organizer,attendees,isAllDay,"
    "isCancelled,showAs,isOnlineMeeting,onlineMeeting,categories,"
    "responseStatus,bodyPreview,recurrence,type"
)

CHAT_FIELDS = "id,chatType,topic,createdDateTime,lastUpdatedDateTime"

TEAM_FIELDS = "id,displayName,description"

CHANNEL_FIELDS = "id,displayName,description,membershipType"

MAIL_LIST_FIELDS = (
    "id,subject,from,toRecipients,receivedDateTime,bodyPreview,"
    "isRead,hasAttachments,importance,flag"
)

USER_PROFILE_FIELDS = "id,displayName,mail,jobTitle,department,officeLocation"
