import { Controller, Get, Inject } from "@nestjs/common";

import { TranslationApiService } from "../translation-api.service";

@Controller("api/auth/status")
export class AuthController {
    constructor(
        @Inject(TranslationApiService)
        private readonly api: TranslationApiService,
    ) {}

    @Get()
    getStatus() {
        return this.api.getAuthStatus();
    }
}
