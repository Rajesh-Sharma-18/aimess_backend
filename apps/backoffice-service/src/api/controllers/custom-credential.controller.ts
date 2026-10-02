import { HTTP_STATUS, t } from "@aimess/constants";
import { ApiResponse } from "@aimess/utils";
import type { RequestHandler } from "express";

import { getRequestContext } from "../../lib/request-context.js";
import { customCredentialService } from "../../services/index.js";
import type {
  CreateCustomCredentialBody,
  CustomCredentialIdParam,
  UpdateCustomCredentialBody,
} from "../validators/custom-credential.validator.js";

export const listCustomCredentials: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await customCredentialService.list();
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_CUSTOM_CREDENTIALS_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

export const getCustomCredential: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { credentialId } = req.params as CustomCredentialIdParam;
      const result = await customCredentialService.reveal(
        credentialId,
        req.admin!.id,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_CUSTOM_CREDENTIAL_FETCHED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

export const createCustomCredential: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const result = await customCredentialService.create(
        req.body as CreateCustomCredentialBody,
        req.admin!.id,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.CREATED)
        .json(
          new ApiResponse(result, t("ADMIN_CUSTOM_CREDENTIAL_CREATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

export const updateCustomCredential: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { credentialId } = req.params as CustomCredentialIdParam;
      const result = await customCredentialService.update(
        credentialId,
        req.body as UpdateCustomCredentialBody,
        req.admin!.id,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(result, t("ADMIN_CUSTOM_CREDENTIAL_UPDATED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};

export const deleteCustomCredential: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const { credentialId } = req.params as CustomCredentialIdParam;
      await customCredentialService.remove(
        credentialId,
        req.admin!.id,
        getRequestContext(req)
      );
      res
        .status(HTTP_STATUS.OK)
        .json(
          new ApiResponse(null, t("ADMIN_CUSTOM_CREDENTIAL_DELETED", req.locale))
        );
    } catch (error) {
      next(error);
    }
  })();
};
