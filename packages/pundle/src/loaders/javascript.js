/* @flow */

import type { Config, LoaderResult } from '../types'

export default function processJavascript(config: Config, filePath: string, contents: string): LoaderResult {
  const toReturn = {}
  toReturn.imports = new Set()
  toReturn.sourceMap = {}
  toReturn.contents = contents
  return toReturn
}
