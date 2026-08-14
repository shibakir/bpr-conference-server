import { Body, Controller, Get, HttpCode, Inject, Post, Query } from "@nestjs/common";

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

    @Post()
    @HttpCode(200)
    createToken(@Body() body: unknown) {
        return this.api.getToken(body as RequestQuery);
    }
}
