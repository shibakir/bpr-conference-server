import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Query } from "@nestjs/common";

import { type RequestQuery, TranslationApiService } from "../translation-api.service";

@Controller("api/translate")
export class TranslationsController {
    constructor(
        @Inject(TranslationApiService)
        private readonly api: TranslationApiService,
    ) {}

    @Post()
    @HttpCode(200)
    startTranslation(@Body() body: unknown) {
        return this.api.startTranslation(body);
    }

    @Delete()
    deleteTranslation(@Body() body: unknown) {
        return this.api.unsubscribe(body);
    }

    @Get("status")
    getStatus(@Query() query: RequestQuery) {
        return this.api.getTranslationStatus(query);
    }

    @Post("unsubscribe")
    @HttpCode(200)
    unsubscribe(@Body() body: unknown) {
        return this.api.unsubscribe(body);
    }
}
