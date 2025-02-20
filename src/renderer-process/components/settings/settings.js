const classnames = require('classnames');
const React = require('react');
const {Formik, Form, Field} = require('formik');
const {
	updateS3SettingsFormSchema,
} = require('../../../shared/validation/form-schemas/settings');
const {
	validateSetupS3SettingsForm,
	validateUpdateS3SettingsForm,
} = require('../../validators/settings-validator');
const utils = require('../../common/utils');
const {
	STORE_KEYS,
} = require('../../common/constants');
const store = require('../../common/store');
const Base = require('../shared/base');
const SuccessIcon = require('../shared/success-icon');

const {api, dialog} = window;

module.exports = class Settings extends Base {
	constructor(props) {
		super(props);
		this.validators = {
			validateSetupS3SettingsForm: utils.makeFormikValidator(validateSetupS3SettingsForm),
			validateUpdateS3SettingsForm: utils.makeFormikValidator(validateUpdateS3SettingsForm),
		};
		this.state.requestPool = new Set();
		this.state.settings = store.get(STORE_KEYS.SETTINGS);
		this.state.isSubmitSuccess = false;
		this.state.isSyncSuccess = false;
	}

	generateS3SettingsInitialValues(settings) {
		return {
			accessKeyId: settings?.accessKeyId || '',
			secretAccessKey: '',
			region: settings?.region || '',
			bucket: settings?.bucket || '',
			endpoint: settings?.endpoint || '',
		};
	}

	onClickSyncButton = async event => {
		const requestId = Math.random().toString(36);

		event.preventDefault();
		try {
			utils.addBusyClass();
			this.setState(prevState => ({
				requestPool: new Set([...prevState.requestPool, requestId]),
				isSyncSuccess: false,
			}));

			await api.syncObjectsFromS3();
			this.setState({isSyncSuccess: true});
		} catch (error) {
			dialog.showErrorBox('Error', `${error.message}`);
		} finally {
			utils.removeBusyClass();
			this.setState(prevState => {
				prevState.requestPool.delete(requestId);
				return {requestPool: new Set(prevState.requestPool)};
			});
		}
	};

	onSubmitUpdateS3SettingsForm = async (values, {resetForm}) => {
		const requestId = Math.random().toString(36);

		try {
			utils.addBusyClass();
			this.setState(prevState => ({
				requestPool: new Set([...prevState.requestPool, requestId]),
				isSubmitSuccess: false,
			}));

			const result = await api.updateS3Settings({
				...values,
				secretAccessKey: values.secretAccessKey || undefined,
			});
			const nextSettings = {
				...store.get(STORE_KEYS.SETTINGS),
				...result,
			};

			await api.syncObjectsFromS3();
			store.set(STORE_KEYS.SETTINGS, nextSettings);
			this.setState({
				isSubmitSuccess: true,
				settings: nextSettings,
			});
			resetForm({values: this.generateS3SettingsInitialValues(nextSettings)});
		} catch (error) {
			dialog.showErrorBox('Error', `${error.message}`);
		} finally {
			utils.removeBusyClass();
			this.setState(prevState => {
				prevState.requestPool.delete(requestId);
				return {requestPool: new Set(prevState.requestPool)};
			});
		}
	};

	renderCreateFolderForm = ({errors, submitCount}) => {
		const {settings, requestPool, isSubmitSuccess} = this.state;
		const isSetupS3Settings = !settings?.accessKeyId;
		const isSubmitted = submitCount > 0;
		const isApiProcessing = requestPool.size > 0;

		return (
			<Form className="card shadow-sm">
				<div className="card-header">
					S3 Settings
				</div>
				<div className="card-body">
					<div className="mb-3">
						<label htmlFor="input-accessKeyId" className="form-label">Access Key ID</label>
						<Field
							autoFocus
							type="text" id="input-accessKeyId" name="accessKeyId"
							className={classnames(
								'form-control',
								{'is-invalid': errors.accessKeyId && isSubmitted},
							)}
							maxLength={updateS3SettingsFormSchema.accessKeyId.max}/>
						{
							(errors.accessKeyId && isSubmitted) && (
								<div className="invalid-feedback">
									{errors.accessKeyId}
								</div>
							)
						}
					</div>
					<div className="mb-3">
						<label htmlFor="input-secretAccessKey" className="form-label">
							{`Secret Access Key${isSetupS3Settings ? '' : ' (Optional)'}`}
						</label>
						<Field
							type="password" id="input-secretAccessKey" name="secretAccessKey"
							className={classnames(
								'form-control',
								{'is-invalid': errors.secretAccessKey && isSubmitted},
							)}
							maxLength={updateS3SettingsFormSchema.secretAccessKey.max}/>
						{
							(errors.secretAccessKey && isSubmitted) && (
								<div className="invalid-feedback">
									{errors.secretAccessKey}
								</div>
							)
						}
						{
							!isSetupS3Settings && (
								<div className="form-text">
									{'Keep empty when you don\'t want to change it.'}
								</div>
							)
						}
					</div>
					<div className="mb-3">
						<label htmlFor="input-region" className="form-label">Region</label>
						<Field
							type="text" id="input-region" name="region"
							className={classnames(
								'form-control',
								{'is-invalid': errors.region && isSubmitted},
							)}
							maxLength={updateS3SettingsFormSchema.region.max}/>
						{
							(errors.region && isSubmitted) && (
								<div className="invalid-feedback">
									{errors.region}
								</div>
							)
						}
					</div>
					<div className="mb-3">
						<label htmlFor="input-bucket" className="form-label">Bucket</label>
						<Field
							type="text" id="input-bucket" name="bucket"
							className={classnames(
								'form-control',
								{'is-invalid': errors.bucket && isSubmitted},
							)}
							maxLength={updateS3SettingsFormSchema.bucket.max}/>
						{
							(errors.bucket && isSubmitted) && (
								<div className="invalid-feedback">
									{errors.bucket}
								</div>
							)
						}
					</div>
					<div className="mb-3">
						<label htmlFor="input-endpoint" className="form-label">Endpoint</label>
						<Field
							type="text" id="input-endpoint" name="endpoint"
							className={classnames(
								'form-control',
								{'is-invalid': errors.endpoint && isSubmitted},
							)}
							maxLength={updateS3SettingsFormSchema.endpoint.max}/>
						{
							(errors.endpoint && isSubmitted) && (
								<div className="invalid-feedback">
									{errors.endpoint}
								</div>
							)
						}
					</div>
					<div className="d-flex align-items-center">
						<button disabled={isApiProcessing} type="submit" className="btn btn-outline-primary">
							Save
						</button>
						{isSubmitSuccess && <SuccessIcon className="ms-2"/>}
					</div>
				</div>
			</Form>
		);
	};

	render() {
		const {
			validateSetupS3SettingsForm,
			validateUpdateS3SettingsForm,
		} = this.validators;
		const {settings, requestPool, isSyncSuccess} = this.state;
		const isSetupS3Settings = !settings?.accessKeyId;
		const isApiProcessing = requestPool.size > 0;

		return (
			<>
				<div className="row justify-content-center mb-3">
					<div className="col-12 col-sm-10 col-md-8 col-lg-6">
						<Formik
							initialValues={this.generateS3SettingsInitialValues(settings)}
							validate={isSetupS3Settings ? validateSetupS3SettingsForm : validateUpdateS3SettingsForm}
							onSubmit={this.onSubmitUpdateS3SettingsForm}
						>
							{this.renderCreateFolderForm}
						</Formik>
					</div>
				</div>

				<div className="row justify-content-center">
					<div className="col-12 col-sm-10 col-md-8 col-lg-6">
						<div className="card shadow-sm">
							<div className="card-header">
								Sync from S3
							</div>
							<div className="card-body">
								<div className="mb-2">
									<label className="form-label">Sync objects from AWS S3.</label>
								</div>
								<div className="d-flex align-items-center">
									<button
										disabled={isApiProcessing}
										type="button" className="btn btn-outline-primary"
										onClick={this.onClickSyncButton}
									>
										Sync
									</button>
									{isSyncSuccess && <SuccessIcon className="ms-2"/>}
								</div>
							</div>
						</div>
					</div>
				</div>
			</>
		);
	}
};
