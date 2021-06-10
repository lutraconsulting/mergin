// Copyright (C) 2018 Lutra Consulting Limited. All rights reserved.
// Do not distribute without the express permission of the author.

import CryptoJS from 'crypto-js/core'
import 'crypto-js/sha1'
import difference from 'lodash/difference'

export const CHUNK_SIZE = 10 * 1024 * 1024

function arrayBufferToWordArray (ab) {
  const i8a = new Uint8Array(ab)
  const a = []
  for (let i = 0; i < i8a.length; i += 4) {
    a.push(i8a[i] << 24 | i8a[i + 1] << 16 | i8a[i + 2] << 8 | i8a[i + 3])
  }
  return CryptoJS.lib.WordArray.create(a, i8a.length)
}

export async function getFiles (rootEntry, pingData) {
  const files = []

  async function traverseFileTree (item, pingData, path = null) {
    if (item.isFile && !pingData.blacklist_files.includes(item.name)) {
      let file
      if (item.constructor === File) {
        file = item
      } else {
        file = await new Promise(resolve => item.file(resolve))
      }
      const fileInfo = {
        path: (path || '') + file.name, // save full path
        size: file.size,
        mtime: new Date(file.lastModified),
        file,
        chunks: calculateChunks(file.size)
      }
      files.push(fileInfo)
    } else if (item.isDirectory) {
      const dirReader = item.createReader()
      let entries
      do {
        entries = await new Promise(resolve => dirReader.readEntries(resolve))
        for (const entry of entries) {
          if (pingData.blacklist_dirs.includes(item.name)) {
            continue
          }
          await traverseFileTree(entry, pingData, path === null ? '' : path + item.name + '/')
        }
      } while (entries.length)
    }
  }

  await traverseFileTree(rootEntry, pingData)
  return files
}

export function checksum (file) {
  return new Promise(resolve => {
    const fileSize = file.size
    const chunkSize = 256 * 1024
    let offset = 0
    const hash = CryptoJS.algo.SHA1.create()

    const readEventHandler = e => {
      // offset += e.target.result.length
      offset += e.target.result.byteLength

      // hash.update(e.target.result)
      hash.update(arrayBufferToWordArray(e.target.result))
      if (offset >= fileSize) {
        const h = hash.finalize()
        resolve(CryptoJS.enc.Hex.stringify(h))
      } else {
        chunkReaderBlock(offset, chunkSize, file)
      }
    }

    const chunkReaderBlock = (_offset, length, _file) => {
      const r = new FileReader()
      const blob = _file.slice(_offset, length + _offset)
      r.onload = readEventHandler
      r.readAsArrayBuffer(blob)
      // r.readAsText(blob)
    }
    chunkReaderBlock(offset, chunkSize, file)
  })
}

export function filesDiff (oldFiles, newFiles) {
  const oFilesPaths = Object.keys(oldFiles).filter(path => !ignoreFile(path))
  const nFilesPaths = Object.keys(newFiles).filter(path => !ignoreFile(path))

  const updated = Object.keys(oldFiles).filter(path => {
    const f2 = newFiles[path]
    return f2 && f2.checksum !== oldFiles[path].checksum
  })
  const added = difference(nFilesPaths, oFilesPaths)
  const removed = difference(oFilesPaths, nFilesPaths)

  // const moved = removed.filter(path => oldFiles[path].checksum)

  const moved = []
  removed.forEach(path => {
    const rf = oldFiles[path]
    const sameFile = Object.values(newFiles).find(
      f => f.checksum === rf.checksum && f.size === rf.size && !moved.find(f2 => f.path === f2.new_path)
    )
    if (sameFile) {
      moved.push({
        path,
        new_path: sameFile.path,
        checksum: sameFile.checksum,
        size: sameFile.size
      })
    }
  })
  const diff = {
    added: difference(added, moved.map(f => f.new_path)),
    removed: difference(removed, moved.map(f => f.path)),
    updated,
    moved
  }
  diff.changes = Object.values(diff).reduce((sum, list) => sum + list.length, 0)
  // return Object.values(diff).reduce((sum, list) => sum + list.length, 0) ? diff : null
  return diff
}

function splitFilePath (filePath) {
  const filename = filePath.replace(/^.*\//, '')
  const extension = filename.lastIndexOf('.') > 0 ? filename.split('.').pop() : ''
  return { filename, extension }
}

function ignoreFile (filePath) {
  const ignoreExt = ['-shm', '-wal', '~', 'pyc', 'swap']
  const { extension } = splitFilePath(filePath)
  return new RegExp(`(${ignoreExt.join('|')})$`, 'g').test(extension)
}

export function isVersionedFile (filePath) {
  const { extension } = splitFilePath(filePath)
  return ['gpkg', 'sqlite'].includes(extension)
}

export function calculateChunks (fileSize) {
  const chunks = []
  for (let i = 0; i < Math.ceil(fileSize / CHUNK_SIZE); i++) {
    chunks.push(Math.random().toString(36).substring(2))
  }
  return chunks
}

export function parseError (error, msg = '') {
  return (error.response && error.response.data && error.response.data.detail) ? error.response.data.detail : msg
}