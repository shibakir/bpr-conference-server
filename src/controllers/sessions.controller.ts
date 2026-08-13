import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpCode,
    Inject,
    Param,
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

    @Delete(":sessionId")
    deleteSession(@Param("sessionId") sessionId: string) {
        return this.api.deleteSession(sessionId);
    }
}
