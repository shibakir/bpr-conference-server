import { Controller, Get, Inject, Query } from "@nestjs/common";

import { type RequestQuery, TranslationApiService } from "../translation-api.service";

@Controller("api/token")
export class TokensController {
    constructor(
        @Inject(TranslationApiService)
        private readonly api: TranslationApiService,
    ) {}

    @Get()
    getToken(@Query() query: RequestQuery) {
        return this.api.getToken(query);
    }
}
