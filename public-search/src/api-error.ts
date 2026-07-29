import { CrawlInputError } from "./crawl-input";
import { CrawlStatusFilterError } from "./crawl-status";
import { RequestBodyTooLargeError, UnsupportedMediaTypeError } from "./request";
import { SearchQueryError } from "./search-query";
import { CrawlPolicyError } from "./crawl-policy";
import { SearchOptionsError } from "./search-options";
import { MaintenanceInputError } from "./maintenance";
import { SchedulerConfigError } from "./scheduler";

export function publicApiError(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) return { status: 413, message: error.message };
  if (error instanceof UnsupportedMediaTypeError) return { status: 415, message: error.message };
  if (error instanceof CrawlInputError || error instanceof CrawlPolicyError || error instanceof CrawlStatusFilterError || error instanceof SearchQueryError || error instanceof SearchOptionsError || error instanceof MaintenanceInputError || error instanceof SchedulerConfigError) return { status: 400, message: error.message };
  if (error instanceof SyntaxError) return { status: 400, message: "Request body must contain valid JSON." };
  return { status: 400, message: "Invalid request." };
}
