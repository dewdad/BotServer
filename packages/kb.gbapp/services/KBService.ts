/*****************************************************************************\
|                                               ( )_  _                       |
|    _ _    _ __   _ _    __    ___ ___     _ _ | ,_)(_)  ___   ___     _     |
|   ( '_`\ ( '__)/'_` ) /'_ `\/' _ ` _ `\ /'_` )| |  | |/',__)/' _ `\ /'_`\   |
|   | (_) )| |  ( (_| |( (_) || ( ) ( ) |( (_| || |_ | |\__, \| (˅) |( (_) )  |
|   | ,__/'(_)  `\__,_)`\__  |(_) (_) (_)`\__,_)`\__)(_)(____/(_) (_)`\___/'  |
|   | |                ( )_) |                                                |
|   (_)                 \___/'                                                |
|                                                                             |
| General Bots Copyright (c) Pragmatismo.io. All rights reserved.             |
| Licensed under the AGPL-3.0.                                                |
|                                                                             |
| According to our dual licensing model, this program can be used either      |
| under the terms of the GNU Affero General Public License, version 3,        |
| or under a proprietary license.                                             |
|                                                                             |
| The texts of the GNU Affero General Public License with an additional       |
| permission and of our proprietary license can be found at and               |
| in the LICENSE file you have received along with this program.              |
|                                                                             |
| This program is distributed in the hope that it will be useful,             |
| but WITHOUT ANY WARRANTY, without even the implied warranty of              |
| MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the                |
| GNU Affero General Public License for more details.                         |
|                                                                             |
| "General Bots" is a registered trademark of Pragmatismo.io.                 |
| The licensing of the program under the AGPLv3 does not imply a              |
| trademark license. Therefore any rights, title and interest in              |
| our trademarks remain entirely with us.                                     |
|                                                                             |
\*****************************************************************************/

/**
 * @fileoverview Knowledge base services and logic.
 */

var Excel = require('exceljs');
const Path = require('path');
const Fs = require('fs');
const urlJoin = require('url-join');
const marked = require('marked');
const path = require('path');
const asyncPromise = require('async-promises');
const walkPromise = require('walk-promise');
// tslint:disable-next-line:newline-per-chained-call
const parse = require('bluebird').promisify(require('csv-parse'));
const { SearchService } = require('azure-search-client');

import { IGBKBService, GBDialogStep, GBLog, IGBConversationalService, IGBCoreService, IGBInstance, GBMinInstance } from 'botlib';
import { Op } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { AzureDeployerService } from '../../azuredeployer.gbapp/services/AzureDeployerService';
import { GuaribasPackage } from '../../core.gbapp/models/GBModel';
import { GBDeployer } from '../../core.gbapp/services/GBDeployer';
import { GuaribasAnswer, GuaribasQuestion, GuaribasSubject } from '../models';
import { Messages } from '../strings';
import { GBConfigService } from './../../core.gbapp/services/GBConfigService';
import { CSService } from '../../customer-satisfaction.gbapp/services/CSService';


/**
 * Result for quey on KB data.
 */
export class KBServiceSearchResults {
  public answer: GuaribasAnswer;
  public questionId: number;
}

/**
 * All services related to knowledge base management.
 */
export class KBService implements IGBKBService {
  public sequelize: Sequelize;

  constructor(sequelize: Sequelize) {
    this.sequelize = sequelize;
  }

  public static getFormattedSubjectItems(subjects: GuaribasSubject[]) {
    if (subjects === null) {
      return '';
    }
    const out = [];
    subjects.forEach(subject => {
      out.push(subject.title);
    });

    return out.join(', ');
  }

  public static getSubjectItemsSeparatedBySpaces(subjects: GuaribasSubject[]) {
    const out = [];
    if (subjects === undefined) { return ''; }
    subjects.forEach(subject => {
      out.push(subject.internalId);
    });

    return out.join(' ');
  }

  public async getAnswerTextByMediaName(instanceId: number, answerMediaName: string): Promise<string> {
    const answer = await GuaribasAnswer.findOne({
      where: {
        instanceId: instanceId,
        media: answerMediaName
      }
    });

    return answer != null ? answer.content : null;
  }

  public async getQuestionById(instanceId: number, questionId: number): Promise<GuaribasQuestion> {
    return GuaribasQuestion.findOne({
      where: {
        instanceId: instanceId,
        questionId: questionId
      }
    });
  }

  public async getAnswerById(instanceId: number, answerId: number): Promise<GuaribasAnswer> {
    return GuaribasAnswer.findOne({
      where: {
        instanceId: instanceId,
        answerId: answerId
      }
    });
  }

  public async getAnswerByText(instanceId: number, text: string): Promise<any> {

    text = text.trim();
    const service = new CSService();
    let question = await service.getQuestionFromAlternateText(instanceId, text);

    if (question !== null) {
      question = await GuaribasQuestion.findOne({
        where: {
          instanceId: instanceId,
          content: { [Op.like]: `%${text}%` }
        }
      });
    }

    if (question !== null) {
      const answer = await GuaribasAnswer.findOne({
        where: {
          instanceId: instanceId,
          answerId: question.answerId
        }
      });

      return Promise.resolve({ question: question, answer: answer });
    }

    return Promise.resolve(undefined);
  }

  public async addAnswer(obj: GuaribasAnswer): Promise<GuaribasAnswer> {
    return await GuaribasAnswer.create(obj);
  }

  public async ask(
    instance: IGBInstance,
    query: string,
    searchScore: number,
    subjects: GuaribasSubject[]
  ): Promise<KBServiceSearchResults> {
    // Builds search query.

    query = query.toLowerCase();
    query = query.replace('?', ' ');
    query = query.replace('!', ' ');
    query = query.replace('.', ' ');
    query = query.replace('/', ' ');
    query = query.replace('\\', ' ');

    if (subjects !== null) {
      const text = KBService.getSubjectItemsSeparatedBySpaces(subjects);
      if (text !== null) {
        query = `${query} ${text}`;
      }
    }

    // tslint:disable:no-unsafe-any
    if (instance.searchKey !== null && GBConfigService.get('STORAGE_DIALECT') === 'mssql') {
      const client = new SearchService(instance.searchHost.split('.')[0], instance.searchKey);
      const results = await client.indexes.use(instance.searchIndex)
        .buildQuery()
        .filter((f) => f.eq('instanceId', instance.instanceId))
        .search(query)
        .top(1)
        .executeQuery();

      const values = results.result.value;

      if (values && values.length > 0 && values[0]['@search.score'] >= searchScore) {
        const value = await this.getAnswerById(instance.instanceId, values[0].answerId);
        if (value !== null) {
          return Promise.resolve({ answer: value, questionId: values[0].questionId });
        } else {
          return Promise.resolve({ answer: undefined, questionId: 0 });
        }
      }
    } else {
      const data = await this.getAnswerByText(instance.instanceId, query);
      if (data) {
        return Promise.resolve({ answer: data.answer, questionId: data.question.questionId });
      } else {
        return Promise.resolve({ answer: undefined, questionId: 0 });
      }
    }
  }

  public async getSubjectItems(instanceId: number, parentId: number): Promise<GuaribasSubject[]> {
    const where = { parentSubjectId: parentId, instanceId: instanceId };

    return GuaribasSubject.findAll({
      where: where
    });
  }

  public async getFaqBySubjectArray(from: string, subjects: any): Promise<GuaribasQuestion[]> {
    if (subjects) {
      const where = {
        from: from,
        // tslint:disable-next-line: no-null-keyword
        subject1: null,
        // tslint:disable-next-line: no-null-keyword
        subject2: null,
        // tslint:disable-next-line: no-null-keyword
        subject3: null,
        // tslint:disable-next-line: no-null-keyword
        subject4: null
      };

      if (subjects[0] && subjects[0].internalId) {
        where.subject1 = subjects[0].internalId;
      }

      if (subjects[1] && subjects[1].internalId) {
        where.subject2 = subjects[1].internalId;
      }

      if (subjects[2] && subjects[2].internalId) {
        where.subject3 = subjects[2].internalId;
      }

      if (subjects[3] && subjects[3].internalId) {
        where.subject4 = subjects[3].internalId;
      }

      return await GuaribasQuestion.findAll({
        where: where
      });
    } else {
      return await GuaribasQuestion.findAll({
        where: { from: from }
      });
    }
  }

  public async importKbTabularFile(
    filePath: string,
    instanceId: number,
    packageId: number
  ): Promise<GuaribasQuestion[]> {

    var workbook = new Excel.Workbook();
    let data = await workbook.xlsx.readFile(filePath);

    let lastQuestionId: number;
    let lastAnswer: GuaribasAnswer;
    let rows = data._worksheets[1]._rows;

    return asyncPromise.eachSeries(rows, async line => {

      // Skips the first line.

      if (line._cells[0] !== undefined &&
        line._cells[1] !== undefined &&
        line._cells[2] !== undefined &&
        line._cells[3] !== undefined &&
        line._cells[4] !== undefined) {
        // Extracts values from columns in the current line.

        const subjectsText = line._cells[0].value;
        const from = line._cells[1].value;
        const to = line._cells[2].value;
        const question = line._cells[3].value;
        let answer = line._cells[4].value;


        if (!(subjectsText === 'subjects' && from === 'from')
          && (answer !== null && question !== null)) {

          let format = '.txt';

          // Extracts answer from external media if any.

          let media = null;

          if (answer.indexOf('.md') > -1) {
            const mediaFilename = urlJoin(path.dirname(filePath), '..', 'articles', answer);
            if (Fs.existsSync(mediaFilename)) {
              answer = Fs.readFileSync(mediaFilename, 'utf8');
              format = '.md';
              media = path.basename(mediaFilename);
            } else {
              GBLog.info(`[GBImporter] File not found: ${mediaFilename}.`);
              answer = '';
            }
          }

          // Processes subjects hierarchy splitting by dots.

          const subjectArray = subjectsText.split('.');
          let subject1: string;
          let subject2: string;
          let subject3: string;
          let subject4: string;
          let indexer = 0;

          subjectArray.forEach(element => {
            if (indexer === 0) {
              subject1 = subjectArray[indexer].substring(0, 63);
            } else if (indexer === 1) {
              subject2 = subjectArray[indexer].substring(0, 63);
            } else if (indexer === 2) {
              subject3 = subjectArray[indexer].substring(0, 63);
            } else if (indexer === 3) {
              subject4 = subjectArray[indexer].substring(0, 63);
            }
            indexer++;
          });

          // Now with all the data ready, creates entities in the store.

          const answer1 = await GuaribasAnswer.create({
            instanceId: instanceId,
            content: answer,
            format: format,
            media: media,
            packageId: packageId,
            prevId: lastQuestionId !== null ? lastQuestionId : 0
          });

          const question1 = await GuaribasQuestion.create({
            from: from,
            to: to,
            subject1: subject1,
            subject2: subject2,
            subject3: subject3,
            subject4: subject4,
            content: question,
            instanceId: instanceId,
            answerId: answer1.answerId,
            packageId: packageId
          });

          if (lastAnswer !== undefined && lastQuestionId !== 0) {
            await lastAnswer.update({ nextId: lastQuestionId });
          }
          lastAnswer = answer1;
          lastQuestionId = question1.questionId;

          return Promise.resolve(question1.questionId);
        } else {
          // Skips the header.

          return Promise.resolve(undefined);
        }
      }
    });
  }

  public async sendAnswer(min: GBMinInstance, channel: string, step: GBDialogStep, answer: GuaribasAnswer) {
    if (answer.content.endsWith('.mp4')) {
      await this.playVideo(min.conversationalService, step, answer);
    }
    else if (answer.format === '.md') {

      await this.playMarkdown(min, answer, channel, step, min.conversationalService);

    } else if (answer.content.endsWith('.ogg')) {

      await this.playAudio(min, answer, channel, step, min.conversationalService);
    } else {
      await step.context.sendActivity(answer.content);
      await min.conversationalService.sendEvent(step, 'stop', undefined);
    }
  }

  private async playAudio(min: GBMinInstance, answer: GuaribasAnswer, channel: string, step: GBDialogStep, conversationalService: IGBConversationalService) {
    conversationalService.sendAudio(min, step, answer.content);
  }

  private async playMarkdown(min: GBMinInstance, answer: GuaribasAnswer, channel: string, step: GBDialogStep, conversationalService: IGBConversationalService) {
    let html = answer.content;
    marked.setOptions({
      renderer: new marked.Renderer(),
      gfm: true,
      tables: true,
      breaks: false,
      pedantic: false,
      sanitize: false,
      smartLists: true,
      smartypants: false,
      xhtml: false
    });
    html = marked(answer.content);
    if (channel === 'webchat' &&
      GBConfigService.get('DISABLE_WEB') !== 'true') {
      await this.sendMarkdownToWeb(step, conversationalService, html, answer);
    }
    else if (channel === 'whatsapp') {
      await conversationalService.sendMarkdownToMobile(min, step, null, answer.content);
    }
    else {
      await step.context.sendActivity(html);
    }
  }

  private async sendMarkdownToWeb(step: GBDialogStep, conversationalService: IGBConversationalService, html: string, answer: GuaribasAnswer) {
    const locale = step.context.activity.locale;
    await step.context.sendActivity(Messages[locale].will_answer_projector);
    html = html.replace(/src\=\"kb\//g, `src=\"../kb/`);
    await conversationalService.sendEvent(step, 'play', {
      playerType: 'markdown',
      data: {
        content: html,
        answer: answer,
        prevId: answer.prevId,
        nextId: answer.nextId
      }
    });
  }


  private async playVideo(conversationalService: IGBConversationalService, step: GBDialogStep, answer: GuaribasAnswer) {
    await conversationalService.sendEvent(step, 'play', {
      playerType: 'video',
      data: answer.content
    });
  }

  public async importKbPackage(
    localPath: string,
    packageStorage: GuaribasPackage,
    instance: IGBInstance
  ): Promise<any> {

    // Imports subjects tree into database and return it.

    await this.importSubjectFile(packageStorage.packageId, urlJoin(localPath, 'subjects.json'), instance);

    // Import tabular files in the tabular directory.

    await this.importKbTabularDirectory(localPath, instance, packageStorage.packageId);

    // Import remaining .md files in articles directory.

    return await this.importRemainingArticles(localPath, instance, packageStorage.packageId);
  }

  /**
   * Import all .md files in artcles folder that has not been referenced by tabular files.
   */
  public async importRemainingArticles(localPath: string, instance: IGBInstance, packageId: number): Promise<any> {
    const files = await walkPromise(urlJoin(localPath, 'articles'));

    return Promise.all(
      files.map(async file => {
        if (file.name.endsWith('.md')) {

          let content = await this.getAnswerTextByMediaName(instance.instanceId, file.name);

          if (content === null) {

            const fullFilename = urlJoin(file.root, file.name);
            content = Fs.readFileSync(fullFilename, 'utf-8');

            await GuaribasAnswer.create({
              instanceId: instance.instanceId,
              content: content,
              format: ".md",
              media: file.name,
              packageId: packageId,
              prevId: 0 // TODO: Calculate total rows and increment.
            });
          }
        }
      }));
  }
  public async importKbTabularDirectory(localPath: string, instance: IGBInstance, packageId: number): Promise<any> {
    const files = await walkPromise(urlJoin(localPath, 'tabular'));

    return Promise.all(
      files.map(async file => {
        if (file.name.endsWith('.xlsx')) {
          return await this.importKbTabularFile(urlJoin(file.root, file.name), instance.instanceId, packageId);
        }
      })
    );
  }

  public async importSubjectFile(packageId: number, filename: string, instance: IGBInstance): Promise<any> {
    const subjectsLoaded = JSON.parse(Fs.readFileSync(filename, 'utf8'));

    const doIt = async (subjects: GuaribasSubject[], parentSubjectId: number) => {
      return asyncPromise.eachSeries(subjects, async item => {
        const value = await GuaribasSubject.create({
          internalId: item.id,
          parentSubjectId: parentSubjectId,
          instanceId: instance.instanceId,
          from: item.from,
          to: item.to,
          title: item.title,
          description: item.description,
          packageId: packageId
        });

        if (item.children) {
          return Promise.resolve(doIt(item.children, value.subjectId));
        } else {
          return Promise.resolve(item);
        }
      });
    };

    return doIt(subjectsLoaded.children, undefined);
  }

  public async undeployKbFromStorage(instance: IGBInstance, deployer: GBDeployer, packageId: number) {
    await GuaribasQuestion.destroy({
      where: { instanceId: instance.instanceId, packageId: packageId }
    });
    await GuaribasAnswer.destroy({
      where: { instanceId: instance.instanceId, packageId: packageId }
    });
    await GuaribasSubject.destroy({
      where: { instanceId: instance.instanceId, packageId: packageId }
    });
    await GuaribasPackage.destroy({
      where: { instanceId: instance.instanceId, packageId: packageId }
    });

    GBLog.info("Remember to call rebuild index manually after package removal.");

  }

  /**
   * Deploys a knowledge base to the storage using the .gbkb format.
   *
   * @param localPath Path to the .gbkb folder.
   */
  public async deployKb(core: IGBCoreService, deployer: GBDeployer, localPath: string) {
    const packageType = Path.extname(localPath);
    const packageName = Path.basename(localPath);
    GBLog.info(`[GBDeployer] Opening package: ${localPath}`);
    const packageObject = JSON.parse(Fs.readFileSync(urlJoin(localPath, 'package.json'), 'utf8'));

    const instance = await core.loadInstanceByBotId(packageObject.botId);
    GBLog.info(`[GBDeployer] Importing: ${localPath}`);
    const p = await deployer.deployPackageToStorage(instance.instanceId, packageName);
    await this.importKbPackage(localPath, p, instance);

    deployer.rebuildIndex(instance, new AzureDeployerService(deployer).getKBSearchSchema(instance.searchIndex));
    GBLog.info(`[GBDeployer] Finished import of ${localPath}`);
  }
}
