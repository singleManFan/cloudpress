import { Injectable, Scope } from '@nestjs/common';
import { PassageSchema } from './passage.interface';
import { NOTES_FOLDER, COLLECTION_PASSAGES } from './../../constants'
import * as fs from 'fs'
import * as path from 'path'
import * as moment from 'moment'
import * as yaml from 'js-yaml'
import * as prettier from 'prettier'
import { LoggerService } from 'src/services/logger.service';
import { TcbService } from 'src/services/tcb.service';
import { AsyncLimitService } from 'src/services/async-limit.service';

import { EventEmitter } from 'events';

const fsPromises = fs.promises;
let uploaded = false;

@Injectable({
    scope: Scope.DEFAULT
})
export class PassageService extends EventEmitter {
    private readonly folderName: string
    private readonly mdRe: RegExp
    private readonly validNameRe: RegExp
    private readonly timeFormat: string
    private passages: PassageSchema[]

    constructor(
        private readonly loggerService: LoggerService,
        private readonly tcbService: TcbService,
        private readonly asyncLimitService: AsyncLimitService
    ) {
        super()
        this.folderName = NOTES_FOLDER
        this.mdRe = /(---\n((.|\n)*?)\n---\n)?((.|\n)*)/
        this.validNameRe = /^\d+\./
        this.timeFormat = 'YYYY-MM-DD HH:mm:ss'
        this.passages = []

        this.asyncLimitService.init('passage', 10)

        this.on('upload', this.onUpload)
    }

    public async load(asc: boolean = false) {
        if (!fs.existsSync(this.folderName)) {
            throw new Error(`Load passage fail: ${this.folderName} is invalid`)
        }

        this.loggerService.info({ content: 'Start load passage', logType: 'LoadPassageStart' })
        this.passages = []

        await this._load(this.folderName)
        this.emit('upload')

        if (asc) {
            this.passages.sort((a, b) => {
                if (a.date < b.date) return -1
                else if (a.date > b.date) return 1
                return 0
            })
        } else {
            this.passages.sort((a, b) => {
                if (a.date < b.date) return 1
                else if (a.date > b.date) return -1
                return 0
            })
        }
        this.loggerService.info({ content: `Finish load ${this.passages.length} valid passages`, logType: 'LoadPassageSuccess' })
        return this.passages
    }

    public describePassageById(psgId: string): PassageSchema {
        return this.passages.find(item => item.permalink === psgId)
    }

    public describePassages(limit: number = 10, page: number = 1): PassageSchema[] {
        return this.passages.slice((page - 1) * limit, page * limit)
    }

    public countAllPassages(): number {
        return this.passages.length
    }

    public describeAllPassageIds(): string[] {
        return this.passages.map(item => item.permalink)
    }

    private async _load(parentPath: string) {
        const folders = await fsPromises.readdir(parentPath);

        for (const folderName of folders) {
            if (!this.isValidName(folderName)) {
                continue
            }

            const folderPath = path.resolve(parentPath, folderName)
            const stat = await fsPromises.stat(folderPath)

            if (stat.isFile() && folderName.endsWith('.md')) {
                try {
                    this.passages.push(await this.parseFile(folderPath))
                } catch (error) {
                    this.loggerService.error({
                        content: `Warning: ${folderPath} parse failed.`,
                        errMsg: error.message
                    })
                }
            } else if (stat.isDirectory()) {
                await this._load(folderPath)
            }
        }
    }

    private async onUpload() {
        if (uploaded) {
            return this.loggerService.info({
                logType: 'UploadRepeated',
                content: 'Please close and rerun server'
            })
        }

        const promises = []
        const { pLimit } = this.asyncLimitService.get('passage')
        for (const passage of this.passages) {
            promises.push(pLimit(() => this.updatePassage(passage)))
        }
        await Promise.all(promises)
        this.loggerService.info({
            logType: 'UploadSuccess'
        })
    }

    /**
     * permalink 是唯一索引
     */
    private async updatePassage(passage: PassageSchema) {
        const collection = this.tcbService.getCollection(COLLECTION_PASSAGES)
        const res1 = await collection.where({ permalink: passage.permalink }).get()
        if (res1.data.length) {
            await collection.doc(res1.data[0]._id).update(passage)
        } else {
            await collection.add(passage)
        }
        this.loggerService.info({
            logType: 'UpdatePassageSuccess',
            content: JSON.stringify({
                title: passage.title,
                id: passage.permalink
            })
        })
    }

    private isValidName(name: string): boolean {
        if (name.toLocaleLowerCase() === 'readme.md') {
            return true
        }
        return this.validNameRe.test(name);
    }

    private async parseFile(filepath: string): Promise<PassageSchema> {
        const content = await fsPromises.readFile(filepath, {
            encoding: 'utf8'
        })
        const [, , yamlContent, , mdContent] = this.mdRe.exec(content)
        const yamlInfo = yaml.safeLoad(yamlContent)

        if (yamlInfo && yamlInfo.permalink) {
            let mtimeStr = this.formatDate(yamlInfo.date)
            let formatMdContent = prettier.format(mdContent, { parser: 'markdown' })
            let filename = this.parseName(filepath)
            return {
                filename,
                filepath,
                title: yamlInfo.title || filename,
                content: formatMdContent,
                description: formatMdContent
                    .replace(/\n/g, "")
                    .trim()
                    .slice(0, 155) + ".....",
                mtime: mtimeStr,
                date: mtimeStr.slice(0, 10),
                permalink: yamlInfo.permalink
            }
        }
        throw new Error(`${filepath}'s frontmatter is invalid`)
    }

    private parseName(filepath: string): string {
        const info = path.parse(filepath)
        if (info.name.toLocaleLowerCase() !== 'readme') {
            return info.name
        } else {
            // /workhome/notes/patha/pathb/06.云开发.md
            // => 云开发
            return info.dir.split(path.sep).pop().replace(/^\d*?\./, '')
        }
    }

    private formatDate(timeStr): string {
        if (!timeStr) {
            return moment().format(this.timeFormat)
        }

        const instance = moment(timeStr, true)
        if (!instance.isValid()) {
            throw new Error(`frontmatter.date is valid`)
        }

        const res = instance.format(this.timeFormat)
        if (res.toLowerCase().includes('invalid')) {
            return moment().format(this.timeFormat)
        } else {
            return res
        }
    }
}