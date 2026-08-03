export const EVENT_LIST_FIELDS =
  "id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,showAs,isOnlineMeeting,onlineMeeting,categories,responseStatus,bodyPreview,recurrence,type";

export const CHAT_FIELDS = "id,chatType,topic,createdDateTime,lastUpdatedDateTime";

export const TEAM_FIELDS = "id,displayName,description";

export const CHANNEL_FIELDS = "id,displayName,description,membershipType";

export const MAIL_LIST_FIELDS =
  "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,importance,flag,webLink,conversationId,parentFolderId";

export const MAIL_FOLDER_FIELDS =
  "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount";

export const USER_PROFILE_FIELDS = "id,displayName,mail,jobTitle,department,officeLocation";

export const MAIL_COMPACT_FIELDS = "id,subject,from,receivedDateTime,isRead,hasAttachments,webLink";

export const EVENT_COMPACT_FIELDS = "id,subject,start,end,organizer,isCancelled,responseStatus";

export const DRIVE_ITEM_COMPACT_FIELDS = "id,name,size,lastModifiedDateTime,file,folder,webUrl";

export const CONTACT_COMPACT_FIELDS = "id,displayName,emailAddresses";

export const USER_COMPACT_FIELDS = "id,displayName,mail";
