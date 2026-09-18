// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .future/ folder
export const FUTURE_FOLDER_PERMISSION_PATTERN = '/.future/**'

// Permission pattern for granting session-level access to the global ~/.future/ folder
export const GLOBAL_FUTURE_FOLDER_PERMISSION_PATTERN = '~/.future/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
