const fs = require('fs');
const path = require('path');
const mimeTypes = require('mime-types');
const pLimit = require('p-limit');
const {Op, UniqueConstraintError} = require('sequelize');
const {
	NotFoundError,
	ConflictError,
} = require('../../../shared/errors');
const OBJECT_TYPE = require('../../../shared/constants/object-type');
const FRONTEND_OPERATION_CODE = require('../../../shared/constants/frontend-operation-code');
const STORAGE_CLASS = require('../../../shared/constants/storage-class');
const s3 = require('../../common/s3');
const utils = require('../../common/utils');
const ObjectModel = require('../../models/data/object-model');

/**
 * @param {string} dirname
 * @param {string} keyword
 * @param {integer} after
 * @param {integer} limit
 * @returns {Promise<{hasNextPage: boolean, items: ObjectModel[]}>}
 */
exports.getObjects = async ({dirname = '', keyword, after, limit = 50} = {}) => {
	const keywordConditions = [];
	const afterConditions = [];

	if (keyword) {
		const {plus, minus} = utils.parseKeyword(keyword);

		plus.forEach(plusKeyword => {
			keywordConditions.push({
				path: {[Op.like]: utils.generateLikeSyntax(plusKeyword)},
			});
		});
		minus.forEach(minusKeyword => {
			keywordConditions.push({
				path: {[Op.notLike]: utils.generateLikeSyntax(minusKeyword)},
			});
		});
	}

	if (after) {
		const cursor = await ObjectModel.findOne({
			where: {id: after},
			attributes: ['id', 'type', 'basename'],
		});

		if (cursor == null) {
			throw new NotFoundError(`not found object ${after}`);
		}

		afterConditions.push(
			{
				[Op.and]: [
					{type: {[Op.gte]: cursor.type}},
					{basename: {[Op.gt]: cursor.basename}},
				],
			},
			{
				[Op.and]: [
					{type: {[Op.gte]: cursor.type}},
					{basename: cursor.basename},
					{id: {[Op.gt]: cursor.id}},
				],
			},
		);
	}

	const objects = await ObjectModel.findAll({
		where: {
			dirname: keywordConditions.length
				? {[Op.like]: utils.generateLikeSyntax(dirname, {start: ''})}
				: dirname,
			...(afterConditions.length ? {[Op.or]: afterConditions} : undefined),
			...(keywordConditions.length ? {[Op.and]: keywordConditions} : undefined),
		},
		order: [
			['type', 'ASC'],
			['basename', 'ASC'],
			['id', 'ASC'],
		],
		limit: limit + 1,
	});

	return {
		hasNextPage: objects.length > limit,
		items: objects.slice(0, limit).map(object => object.toJSON()),
	};
};

/**
 * @param {number} id
 * @returns {Promise<ObjectModel>}
 */
exports.getObject = async ({id} = {}) => {
	const object = await ObjectModel.findOne({where: {id}});

	if (!object) {
		throw new NotFoundError();
	}

	const headers = await s3.headObject(object.path);
	const result = object.toJSON();

	if (headers.ContentType?.startsWith('image/')) {
		result.url = await s3.getSignedUrl(object.path, {expiresIn: 60 * 60});
	} else if (headers.ContentType?.startsWith('video/')) {
		result.url = await s3.getSignedUrl(object.path);
	}

	result.objectHeaders = headers;
	return result;
};

/**
 * @param {string} dirname
 * @param {string} basename
 * @returns {Promise<ObjectModel>}
 */
exports.createFolder = async ({dirname, basename} = {}) => {
	const object = new ObjectModel({
		type: OBJECT_TYPE.FOLDER,
		path: (dirname || null) ? `${dirname}/${basename}/` : `${basename}/`,
	});

	if (object.dirname) {
		const parent = await ObjectModel.findOne({
			where: {
				type: OBJECT_TYPE.FOLDER,
				path: `${object.dirname}/`,
			},
		});

		if (!parent) {
			throw new NotFoundError(`not found parent "${object.dirname}"`);
		}
	}

	try {
		await object.save();
	} catch (error) {
		if (
			error instanceof UniqueConstraintError
			&& (error.errors || [])[0]?.path === 'path'
		) {
			throw new ConflictError(error, {
				frontendOperationCode: FRONTEND_OPERATION_CODE.SHOW_OBJECT_DUPLICATED_ALERT,
				frontendOperationValue: object.path,
			});
		}

		throw error;
	}

	await s3.putObject(object.path);
	return object.toJSON();
};

exports.createFile = async ({localPath, dirname}) => {
	const basename = path.basename(localPath);
	const object = new ObjectModel({
		type: OBJECT_TYPE.FILE,
		path: (dirname || null) ? `${dirname}/${basename}` : `${basename}`,
		storageClass: STORAGE_CLASS.STANDARD,
	});

	if (object.dirname) {
		const parent = await ObjectModel.findOne({
			where: {
				type: OBJECT_TYPE.FOLDER,
				path: `${object.dirname}/`,
			},
		});

		if (!parent) {
			throw new NotFoundError(`not found parent "${object.dirname}"`);
		}
	}

	try {
		await object.save();
	} catch (error) {
		if (
			error instanceof UniqueConstraintError
			&& (error.errors || [])[0]?.path === 'path'
		) {
			throw new ConflictError(error, {
				frontendOperationCode: FRONTEND_OPERATION_CODE.SHOW_OBJECT_DUPLICATED_ALERT,
				frontendOperationValue: object.path,
			});
		}

		throw error;
	}

	try {
		await s3.upload({
			path: object.path,
			content: fs.createReadStream(localPath),
			options: {
				ContentType: mimeTypes.lookup(basename),
			},
		});
		const objectHeaders = await s3.headObject(object.path);

		object.size = objectHeaders.ContentLength;
		object.lastModified = objectHeaders.LastModified;
		await object.save();
	} catch (error) {
		await object.destroy();
		throw error;
	}

	return object.toJSON();
};

/**
 * @param {Array<number>} ids
 * @returns {Promise<null>}
 */
exports.deleteObjects = async ({ids} = {}) => {
	const limit = pLimit(1);
	const files = [];
	const folders = [];
	const objects = await ObjectModel.findAll({
		where: {
			id: {[Op.in]: ids},
		},
	});

	if (objects.length !== ids.length) {
		const existsIds = objects.map(({id}) => id);

		ids.forEach(id => {
			if (!existsIds.includes(id)) {
				throw new NotFoundError(`not found "${id}"`);
			}
		});
	}

	await Promise.all(objects.map(object => limit(async () => {
		if (object.type === OBJECT_TYPE.FILE) {
			files.push(object);
		} else {
			const [deepFiles, deepFolders] = await Promise.all([
				ObjectModel.findAll({
					where: {
						type: OBJECT_TYPE.FILE,
						path: {[Op.like]: utils.generateLikeSyntax(object.path, {start: ''})},
					},
				}),
				ObjectModel.findAll({
					where: {
						type: OBJECT_TYPE.FOLDER,
						path: {[Op.like]: utils.generateLikeSyntax(object.path, {start: ''})},
					},
				}),
			]);

			files.push(...deepFiles);
			folders.push(...deepFolders);
		}
	})));

	if (files.length) {
		await Promise.all([
			s3.deleteObjects(files.map(file => file.path)),
			ObjectModel.destroy({
				where: {id: {[Op.in]: files.map(file => file.id)}},
			}),
		]);
	}

	if (folders.length) {
		await Promise.all([
			s3.deleteObjects(
				folders
					.map(folder => folder.path)
					.sort((a, b) => b.split('/').length - a.split('/').length),
			),
			ObjectModel.destroy({
				where: {id: {[Op.in]: folders.map(folder => folder.id)}},
			}),
		]);
	}

	return null;
};
