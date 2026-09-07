import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    Inject,
    Param,
    Patch,
    Post,
} from "@nestjs/common";

import { type RequestHeaders, TranslationApiService } from "../translation-api.service";

@Controller("api/sessions")
export class SessionsController {
    constructor(
        @Inject(TranslationApiService)
        private readonly api: TranslationApiService,
    ) {}

    @Post()
    @HttpCode(200)
    createSession(@Body() body: unknown, @Headers() headers: RequestHeaders) {
        return this.api.createSession(body, headers);
    }

    @Get()
    getSessions() {
        return this.api.getSessions();
    }

    @Get(":sessionId")
    getSession(@Param("sessionId") sessionId: string) {
        return this.api.getSession(sessionId);
    }

    @Get(":sessionId/translation-settings")
    getTranslationSettings(
        @Param("sessionId") sessionId: string,
        @Headers() headers: RequestHeaders,
    ) {
        return this.api.getTranslationSettings(sessionId, headers);
    }

    @Patch(":sessionId/translation-settings")
    updateTranslationSettings(@Param("sessionId") sessionId: string, @Body() body: unknown) {
        return this.api.updateTranslationSettings(sessionId, body);
    }

    @Get(":sessionId/presenter")
    getPresenterStatus(@Param("sessionId") sessionId: string) {
        return this.api.getPresenterStatus(sessionId);
    }

    @Post(":sessionId/presenter")
    @HttpCode(200)
    claimPresenter(@Param("sessionId") sessionId: string, @Body() body: unknown) {
        return this.api.claimPresenter(sessionId, body);
    }

    @Delete(":sessionId")
    deleteSession(@Param("sessionId") sessionId: string, @Body() body: unknown) {
        return this.api.deleteSession(sessionId, body);
    }
}
