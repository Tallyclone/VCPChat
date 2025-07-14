const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const glob = require('glob');
const { minimatch } = require('minimatch');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const trash = require('trash');
const { editManyFiles } = require('./editManyFilesHandler.js');

// Load environment variables
require('dotenv').config();

// Configuration
const ALLOWED_DIRECTORIES = (process.env.ALLOWED_DIRECTORIES || '')
  .split(',')
  .map(dir => dir.trim())
  .filter(dir => dir);
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 20971520; // 20MB default
const MAX_DIRECTORY_ITEMS = parseInt(process.env.MAX_DIRECTORY_ITEMS) || 1000;
const MAX_SEARCH_RESULTS = parseInt(process.env.MAX_SEARCH_RESULTS) || 100;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
const ENABLE_RECURSIVE_OPERATIONS = process.env.ENABLE_RECURSIVE_OPERATIONS !== 'false';
const ENABLE_HIDDEN_FILES = process.env.ENABLE_HIDDEN_FILES === 'true';

// Utility functions
function debugLog(message, data = null) {
  if (DEBUG_MODE) {
    const timestamp = new Date().toISOString();
    console.error(`[DEBUG ${timestamp}] ${message}`);
    if (data) console.error(JSON.stringify(data, null, 2));
  }
}

function isPathAllowed(targetPath, operationType = 'generic') {
  const resolvedPath = path.resolve(targetPath);

  // 1. 如果在允许的目录内，则授予所有权限。
  if (ALLOWED_DIRECTORIES.length > 0) {
    const isInAllowedDir = ALLOWED_DIRECTORIES.some(allowedDir => {
      const resolvedAllowedDir = path.resolve(allowedDir);
      return resolvedPath.startsWith(resolvedAllowedDir);
    });
    if (isInAllowedDir) {
      debugLog(`Path is within allowed directories. Access granted.`, { targetPath, operationType });
      return true;
    }
  } else {
    // 如果没有配置允许的目录，则允许所有操作（保持原有灵活性）。
    debugLog('No ALLOWED_DIRECTORIES configured, allowing access to all paths.');
    return true;
  }

  // 2. 如果路径在允许的目录之外，则只对只读操作开绿灯。
  const readOnlyBypassOperations = ['ReadFile', 'FileInfo'];
  if (readOnlyBypassOperations.includes(operationType) && path.isAbsolute(targetPath)) {
    debugLog(`Path is outside allowed directories, but operation is a read-only bypass. Access granted.`, { targetPath, operationType });
    return true;
  }
  
  // 3. 对于所有其他情况（例如，在沙箱外的写/删除操作），一律拒绝。
  debugLog(`Access denied. Path is outside allowed directories and operation is not a read-only bypass.`, { targetPath, operationType });
  return false;
}

function formatFileSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
}

function getUniqueFilePath(filePath) {
  if (!fsSync.existsSync(filePath)) {
    return { newPath: filePath, renamed: false };
  }

  let counter = 1;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  let newPath;

  while (true) {
    newPath = path.join(dir, `${baseName}(${counter})${ext}`);
    if (!fsSync.existsSync(newPath)) {
      return { newPath: newPath, renamed: true };
    }
    counter++;
  }
}

// File operation functions
async function readFile(filePath, encoding = 'utf8') {
  try {
    debugLog('Reading file', { filePath, encoding });

    if (!isPathAllowed(filePath, 'ReadFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`,
      );
    }

    const extension = path.extname(filePath).toLowerCase();
    let content;
    let isExtracted = false;

    // Read file as buffer for parsers
    const fileBuffer = await fs.readFile(filePath);

    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'];
    const videoExtensions = ['.mp4', '.webm', '.mov'];

    if (extension === '.pdf') {
      const data = await pdf(fileBuffer);
      content = data.text;
      isExtracted = true;
    } else if (extension === '.docx') {
      const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
      content = value;
      isExtracted = true;
    } else if (['.xlsx', '.xls', '.csv'].includes(extension)) {
      const workbook = new ExcelJS.Workbook();
      if (extension === '.csv') {
        const worksheet = await workbook.csv.read(new (require('stream').Readable)({
          read() { this.push(fileBuffer); this.push(null); }
        }));
      } else {
        await workbook.xlsx.load(fileBuffer);
      }
      let sheetContent = '';
      workbook.eachSheet((worksheet, sheetId) => {
        sheetContent += `--- Sheet: ${worksheet.name} ---\n`;
        worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
          sheetContent += row.values.slice(1).join('\t') + '\n';
        });
      });
      content = sheetContent;
      isExtracted = true;
    } else if (imageExtensions.includes(extension)) {
        const mimeType = `image/${extension.slice(1).replace('jpg', 'jpeg')}`;
        content = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
        isExtracted = true;
    } else if (audioExtensions.includes(extension)) {
        const mimeType = `audio/${extension.slice(1).replace('mp3', 'mpeg')}`;
        content = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
        isExtracted = true;
    } else if (videoExtensions.includes(extension)) {
        const mimeType = `video/${extension.slice(1)}`;
        content = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
        isExtracted = true;
    } else {
      // Fallback for plain text files
      content = fileBuffer.toString(encoding);
    }

    const returnData = {
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
        encoding: isExtracted ? 'utf8' : encoding,
        isExtracted: isExtracted,
        fileName: path.basename(filePath)
    };

    if (isExtracted && content.startsWith('data:image')) {
        returnData.content = [
            { type: 'text', text: `已读取图片文件 '${returnData.fileName}'。` },
            { type: 'image_url', image_url: { url: content } }
        ];
    } else if (isExtracted && (content.startsWith('data:audio') || content.startsWith('data:video'))) {
        // For audio/video, we follow the same structure as images,
        // relying on the data URI's MIME type for the model to differentiate.
        const fileType = content.startsWith('data:audio') ? '音频' : '视频';
        returnData.content = [
            { type: 'text', text: `已读取${fileType}文件 '${returnData.fileName}'。` },
            { type: 'image_url', image_url: { url: content } }
        ];
    } else {
        // For text-based files
        returnData.content = content;
    }

    return {
      success: true,
      data: returnData,
    };
  } catch (error) {
    debugLog('Error reading file', { filePath, error: error.message });
    return {
      success: false,
      error: `Failed to read or process file: ${error.message}`,
    };
  }
}

async function writeFile(filePath, content, encoding = 'utf8') {
  try {
    debugLog('Writing file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath, 'WriteFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    if (Buffer.byteLength(content, encoding) > MAX_FILE_SIZE) {
      throw new Error(`Content too large: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    const { newPath, renamed } = getUniqueFilePath(filePath);

    await fs.writeFile(newPath, content, encoding);
    const stats = await fs.stat(newPath);

    const message = renamed
      ? `已存在同名文件 "${path.basename(filePath)}"，已为您创建为 "${path.basename(newPath)}"`
      : '文件写入成功';

    return {
      success: true,
      data: {
        message: message,
        path: newPath,
        originalPath: filePath,
        renamed: renamed,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error writing file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function appendFile(filePath, content, encoding = 'utf8') {
  try {
    debugLog('Appending to file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath, 'AppendFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    // Check total size after append
    let existingSize = 0;
    try {
      const stats = await fs.stat(filePath);
      existingSize = stats.size;
    } catch (e) {
      // File doesn't exist, which is fine
    }

    const newContentSize = Buffer.byteLength(content, encoding);
    if (existingSize + newContentSize > MAX_FILE_SIZE) {
      throw new Error(`File would be too large after append: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    await fs.appendFile(filePath, content, encoding);
    const stats = await fs.stat(filePath);

    return {
      success: true,
      data: {
        message: 'Content appended successfully',
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error appending to file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function editFile(filePath, content, encoding = 'utf8') {
  try {
    debugLog('Editing file', { filePath, contentLength: content.length, encoding });

    if (!isPathAllowed(filePath, 'EditFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    // Ensure the file exists before attempting to edit it.
    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        throw new Error(`Path points to a directory, not a file. Cannot edit.`);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`File not found at '${filePath}'. Use WriteFile to create a new file.`);
      }
      throw e; // Re-throw other errors
    }

    if (Buffer.byteLength(content, encoding) > MAX_FILE_SIZE) {
      throw new Error(`Content too large: exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`);
    }

    await fs.writeFile(filePath, content, encoding);
    const stats = await fs.stat(filePath);

    return {
      success: true,
      data: {
        message: 'File edited successfully',
        path: filePath,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error editing file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function listDirectory(dirPath, showHidden = ENABLE_HIDDEN_FILES) {
  try {
    debugLog('Listing directory', { dirPath, showHidden });

    if (!isPathAllowed(dirPath, 'ListDirectory')) {
      throw new Error(`Access denied: Path '${dirPath}' is not in allowed directories`);
    }

    const items = await fs.readdir(dirPath);
    const result = [];

    for (const item of items.slice(0, MAX_DIRECTORY_ITEMS)) {
      if (!showHidden && item.startsWith('.')) {
        continue;
      }

      const itemPath = path.join(dirPath, item);
      try {
        const stats = await fs.stat(itemPath);
        result.push({
          name: item,
          path: itemPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : null,
          sizeFormatted: stats.isFile() ? formatFileSize(stats.size) : null,
          lastModified: stats.mtime.toISOString(),
          permissions: stats.mode,
          isHidden: item.startsWith('.'),
        });
      } catch (itemError) {
        debugLog('Error getting item stats', { itemPath, error: itemError.message });
        // Skip items we can't stat
      }
    }

    return {
      success: true,
      data: {
        path: dirPath,
        items: result,
        totalItems: result.length,
        truncated: items.length > MAX_DIRECTORY_ITEMS,
      },
    };
  } catch (error) {
    debugLog('Error listing directory', { dirPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function getFileInfo(filePath) {
  try {
    debugLog('Getting file info', { filePath });

    if (!isPathAllowed(filePath, 'FileInfo')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);

    return {
      success: true,
      data: {
        path: filePath,
        name: path.basename(filePath),
        directory: path.dirname(filePath),
        extension: path.extname(filePath),
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
        lastAccessed: stats.atime.toISOString(),
        created: stats.birthtime.toISOString(),
        permissions: stats.mode,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        isSymbolicLink: stats.isSymbolicLink(),
      },
    };
  } catch (error) {
    debugLog('Error getting file info', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function copyFile(sourcePath, destinationPath) {
  try {
    debugLog('Copying file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath, 'CopyFile') || !isPathAllowed(destinationPath, 'CopyFile')) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    const stats = await fs.stat(sourcePath);
    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large to copy: ${formatFileSize(stats.size)} exceeds limit of ${formatFileSize(MAX_FILE_SIZE)}`,
      );
    }

    const { newPath, renamed } = getUniqueFilePath(destinationPath);

    await fs.copyFile(sourcePath, newPath);
    const destStats = await fs.stat(newPath);

    const message = renamed
      ? `已存在同名文件 "${path.basename(destinationPath)}"，已为您复制为 "${path.basename(newPath)}"`
      : '文件复制成功';

    return {
      success: true,
      data: {
        message: message,
        source: sourcePath,
        destination: newPath,
        originalDestination: destinationPath,
        renamed: renamed,
        size: destStats.size,
        sizeFormatted: formatFileSize(destStats.size),
      },
    };
  } catch (error) {
    debugLog('Error copying file', { sourcePath, destinationPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function moveFile(sourcePath, destinationPath) {
  try {
    debugLog('Moving file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath, 'MoveFile') || !isPathAllowed(destinationPath, 'MoveFile')) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    const { newPath, renamed } = getUniqueFilePath(destinationPath);

    await fs.rename(sourcePath, newPath);
    const stats = await fs.stat(newPath);

    const message = renamed
      ? `移动目标位置已存在同名文件 "${path.basename(destinationPath)}"，已为您移动并重命名为 "${path.basename(newPath)}"`
      : '文件移动成功';

    return {
      success: true,
      data: {
        message: message,
        source: sourcePath,
        destination: newPath,
        originalDestination: destinationPath,
        renamed: renamed,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
      },
    };
  } catch (error) {
    debugLog('Error moving file', { sourcePath, destinationPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function moveManyFiles(sourcePaths, destinations) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    return { success: false, error: 'sourcePaths must be a non-empty array.' };
  }

  const results = {
    succeeded: [],
    failed: [],
  };
  const isMultiTarget = Array.isArray(destinations);

  // “多对多”模式校验
  if (isMultiTarget) {
    if (sourcePaths.length !== destinations.length) {
      return {
        success: false,
        error: `In multi-target mode, sourcePaths and destinations must have the same number of items. Sources: ${sourcePaths.length}, Destinations: ${destinations.length}.`,
      };
    }
  }
  // “多对一”模式校验：只检查类型，权限和是否存在放到循环里
  else if (typeof destinations !== 'string') {
    return { success: false, error: 'destinations must be a string (for single directory) or an array of strings (for multiple targets).' };
  }


  for (let i = 0; i < sourcePaths.length; i++) {
    const sourcePath = sourcePaths[i];
    let destinationPath;

    if (isMultiTarget) {
      destinationPath = destinations[i];
    } else {
      const sourceName = path.basename(sourcePath);
      destinationPath = path.join(destinations, sourceName);
    }

    try {
      // 权限检查
      if (!isPathAllowed(sourcePath, 'MoveManyFiles_Src')) {
        throw new Error(`Access denied: Source path '${sourcePath}' is not in allowed directories`);
      }
      
      const destDir = path.dirname(destinationPath);
      if (!isPathAllowed(destDir, 'MoveManyFiles_Dest')) {
        throw new Error(`Access denied: Destination directory '${destDir}' is not in allowed directories`);
      }
      
      // 确保目标目录存在 (仅在多对多模式下需要每次检查)
      if (isMultiTarget) {
        if (!fsSync.existsSync(destDir)) {
          await fs.mkdir(destDir, { recursive: true });
        }
      }

      // 使用辅助函数处理同名文件
      const { newPath, renamed } = getUniqueFilePath(destinationPath);
      
      // 执行移动
      await fs.rename(sourcePath, newPath);
      
      results.succeeded.push({
        source: sourcePath,
        destination: newPath,
        renamed: renamed,
        message: `Successfully moved to ${newPath}`
      });

    } catch (error) {
      debugLog('Error moving one of the files in batch', { sourcePath, destination: destinationPath, error: error.message });
      results.failed.push({
        source: sourcePath,
        destination: destinationPath,
        error: error.message,
      });
    }
  }

  return {
    success: true,
    data: {
      message: `Batch move completed. Succeeded: ${results.succeeded.length}, Failed: ${results.failed.length}.`,
      succeeded: results.succeeded,
      failed: results.failed,
    }
  };
}

async function renameFile(sourcePath, destinationPath) {
  try {
    debugLog('Renaming file', { sourcePath, destinationPath });

    if (!isPathAllowed(sourcePath, 'RenameFile') || !isPathAllowed(destinationPath, 'RenameFile')) {
      throw new Error('Access denied: One or both paths are not in allowed directories');
    }

    // Check if source file exists
    try {
      await fs.stat(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Source file not found: '${sourcePath}'`);
      }
      throw error;
    }

    // Check if destination file already exists
    if (fsSync.existsSync(destinationPath)) {
      throw new Error(`Destination file already exists: '${destinationPath}'. Please choose a different name.`);
    }

    await fs.rename(sourcePath, destinationPath);
    const stats = await fs.stat(destinationPath);

    return {
      success: true,
      data: {
        message: 'File renamed successfully',
        source: sourcePath,
        destination: destinationPath,
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
      },
    };
  } catch (error) {
    debugLog('Error renaming file', { sourcePath, destinationPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function deleteFile(filePath) {
  try {
    debugLog('Deleting file', { filePath });

    if (!isPathAllowed(filePath, 'DeleteFile')) {
      throw new Error(`Access denied: Path '${filePath}' is not in allowed directories`);
    }

    const stats = await fs.stat(filePath);
    const fileInfo = {
      path: filePath,
      size: stats.size,
      sizeFormatted: formatFileSize(stats.size),
      type: stats.isDirectory() ? 'directory' : 'file',
    };

    await trash(filePath);

    return {
      success: true,
      data: {
        message: `${fileInfo.type} moved to trash successfully`,
        deletedItem: fileInfo,
      },
    };
  } catch (error) {
    debugLog('Error deleting file', { filePath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function createDirectory(dirPath) {
  try {
    debugLog('Creating directory', { dirPath });

    if (!isPathAllowed(dirPath, 'CreateDirectory')) {
      throw new Error(`Access denied: Path '${dirPath}' is not in allowed directories`);
    }

    await fs.mkdir(dirPath, { recursive: true });
    const stats = await fs.stat(dirPath);

    return {
      success: true,
      data: {
        message: 'Directory created successfully',
        path: dirPath,
        created: stats.birthtime.toISOString(),
      },
    };
  } catch (error) {
    debugLog('Error creating directory', { dirPath, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function searchFiles(searchPath, pattern, options = {}) {
  try {
    debugLog('Searching files', { searchPath, pattern, options });

    if (!isPathAllowed(searchPath, 'SearchFiles')) {
      throw new Error(`Access denied: Path '${searchPath}' is not in allowed directories`);
    }

    const {
      caseSensitive = false,
      includeHidden = ENABLE_HIDDEN_FILES,
      fileType = 'all', // 'file', 'directory', 'all'
    } = options;

    const globPattern = path.join(searchPath, '**', pattern);
    const globOptions = {
      dot: includeHidden,
      nocase: !caseSensitive,
      maxDepth: ENABLE_RECURSIVE_OPERATIONS ? undefined : 1,
    };

    const files = glob.sync(globPattern, globOptions).slice(0, MAX_SEARCH_RESULTS);
    const results = [];

    for (const file of files) {
      try {
        const stats = await fs.stat(file);
        const isDirectory = stats.isDirectory();

        if (fileType === 'file' && isDirectory) continue;
        if (fileType === 'directory' && !isDirectory) continue;

        results.push({
          path: file,
          name: path.basename(file),
          directory: path.dirname(file),
          type: isDirectory ? 'directory' : 'file',
          size: isDirectory ? null : stats.size,
          sizeFormatted: isDirectory ? null : formatFileSize(stats.size),
          lastModified: stats.mtime.toISOString(),
          relativePath: path.relative(searchPath, file),
        });
      } catch (statError) {
        debugLog('Error getting stats for search result', { file, error: statError.message });
      }
    }

    return {
      success: true,
      data: {
        searchPath: searchPath,
        pattern: pattern,
        results: results,
        totalResults: results.length,
        truncated: files.length >= MAX_SEARCH_RESULTS,
        options: options,
      },
    };
  } catch (error) {
    debugLog('Error searching files', { searchPath, pattern, error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

async function listAllowedDirectories() {
  debugLog('Listing allowed directories content');
  if (ALLOWED_DIRECTORIES.length === 0) {
    return {
      success: false,
      error: 'No allowed directories configured. Cannot list projects.',
    };
  }

  try {
    const allProjects = {};
    for (const dir of ALLOWED_DIRECTORIES) {
      const items = await fs.readdir(dir);
      const subItems = [];
      for (const item of items.slice(0, MAX_DIRECTORY_ITEMS)) {
        try {
          const itemPath = path.join(dir, item);
          const stats = await fs.stat(itemPath);
          subItems.push({
            name: item,
            type: stats.isDirectory() ? 'directory' : 'file',
          });
        } catch (e) {
          // Ignore items that can't be stat'd
        }
      }
      allProjects[dir] = subItems;
    }
    return { success: true, data: { allowedRoots: allProjects } };
  } catch (error) {
    debugLog('Error listing allowed directories', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Main execution function
async function processRequest(request) {
  // 适配 VCP 标准：将 'command' 字段作为 action，其余字段作为参数
  const { command, ...parameters } = request;
  const action = command;

  debugLog('Processing request', { action, parameters });

  switch (action) {
    case 'ListAllowedDirectories':
      return await listAllowedDirectories();

    case 'ReadFile':
      return await readFile(parameters.filePath, parameters.encoding);

    case 'WriteFile':
      return await writeFile(parameters.filePath, parameters.content, parameters.encoding);

    case 'AppendFile':
      return await appendFile(parameters.filePath, parameters.content, parameters.encoding);

    case 'EditFile':
      return await editFile(parameters.filePath, parameters.content, parameters.encoding);

    case 'ListDirectory':
      return await listDirectory(parameters.directoryPath, parameters.showHidden);

    case 'FileInfo':
      return await getFileInfo(parameters.filePath);

    case 'CopyFile':
      return await copyFile(parameters.sourcePath, parameters.destinationPath);

    case 'MoveFile':
      return await moveFile(parameters.sourcePath, parameters.destinationPath);

    case 'MoveManyFiles':
      // 容错处理：如果 sourcePaths 是字符串，则尝试解析它
      let sourcePaths = parameters.sourcePaths;
      if (typeof sourcePaths === 'string') {
        try {
          sourcePaths = JSON.parse(sourcePaths);
        } catch (e) {
          return { success: false, error: 'Failed to parse sourcePaths string into an array.' };
        }
      }
      // 同样对 destinations 进行容错处理
      let destinations = parameters.destinations;
      if (typeof destinations === 'string') {
        try {
          // 如果它看起来像一个数组字符串，就解析它
          if (destinations.trim().startsWith('[')) {
            destinations = JSON.parse(destinations);
          }
          // 否则，它就是一个普通的目录字符串，保持原样
        } catch (e) {
           return { success: false, error: 'Failed to parse destinations string into an array.' };
        }
      }
      return await moveManyFiles(sourcePaths, destinations);

    case 'RenameFile':
      return await renameFile(parameters.sourcePath, parameters.destinationPath);

    case 'DeleteFile':
      return await deleteFile(parameters.filePath);

    case 'CreateDirectory':
      return await createDirectory(parameters.directoryPath);

    case 'SearchFiles':
      return await searchFiles(parameters.searchPath, parameters.pattern, parameters.options);

    case 'EditManyFiles':
      let modifications = parameters.modifications;
      if (typeof modifications === 'string') {
        try {
          modifications = JSON.parse(modifications);
        } catch (e) {
          return { success: false, error: 'Failed to parse "modifications" parameter. It must be a valid JSON array string.' };
        }
      }
      return await editManyFiles(modifications);

    default:
      return {
        success: false,
        error: `Unknown action: ${action}`,
      };
  }
}

// Setup stdio communication
process.stdin.setEncoding('utf8');
process.stdin.on('data', async data => {
  try {
    const lines = data.toString().trim().split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      const request = JSON.parse(line); // This is now the flat object from VCP
      const response = await processRequest(request);

      // Convert internal format to VCP protocol format
      const vcpResponse = convertToVCPFormat(response);
      console.log(JSON.stringify(vcpResponse));
    }
  } catch (error) {
    const errorResponse = {
      status: 'error',
      error: `Invalid request format: ${error.message}`,
    };
    console.log(JSON.stringify(errorResponse));
  }
});

// Convert internal response format to VCP protocol format
function convertToVCPFormat(response) {
  if (response.success) {
    return {
      status: 'success',
      result: response.data || { message: response.message || 'Operation completed successfully' },
    };
  } else {
    return {
      status: 'error',
      error: response.error || 'Unknown error occurred',
    };
  }
}

// Handle process termination
process.on('SIGTERM', () => {
  debugLog('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  debugLog('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

debugLog('FileOperator plugin started and listening for requests');
