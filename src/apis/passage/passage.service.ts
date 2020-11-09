import { Injectable } from '@nestjs/common';
import { PassageSchema } from './passage.interface';
import * as fs from 'fs'
import * as path from 'path'
import * as moment from 'moment'
import * as yaml from 'js-yaml'
import * as prettier from 'prettier'
import { LoggerService } from 'src/services/logger.service';

const fsPromises = fs.promises;

@Injectable()
export class PassageService {
    private readonly folderName: string
    private readonly mdRe: RegExp
    private readonly validNameRe: RegExp
    private readonly timeFormat: string
    private passages: PassageSchema[]

    constructor(
        private readonly loggerService: LoggerService
    ) {
        this.folderName = process.cwd() + '/notes'
        this.mdRe = /(---\n((.|\n)*?)\n---\n)?((.|\n)*)/
        this.validNameRe = /^\d+\./
        this.timeFormat = 'YYYY-MM-DD HH:mm:ss'
        this.passages = []
    }

    public async load(asc: boolean = false) {
        if (!fs.existsSync(this.folderName)) {
            throw new Error(`${this.folderName} is invalid`)
        }

        this.passages = []
        await this._load(this.folderName)
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
        return this.passages
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
                    this.loggerService.warn({
                        content: `Warning: ${folderPath} parse failed.`
                    })
                }
            } else if (stat.isDirectory()) {
                await this._load(folderPath)
            }
        }
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

        if (yamlInfo) {
            let mtimeStr = this.formatDate(yamlInfo.date)
            let formatMdContent = prettier.format(mdContent, { parser: 'markdown' })
            return {
                filepath,
                title: yamlInfo.title,
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
        throw new Error(`${filepath} is invalid`)
    }

    private formatDate(timeStr): string {
        if (!timeStr) {
            return moment().format(this.timeFormat)
        }

        let res = moment(timeStr).format(this.timeFormat)
        if (res.toLowerCase().includes('invalid')) {
            return moment().format(this.timeFormat)
        } else {
            return res
        }
    }
}