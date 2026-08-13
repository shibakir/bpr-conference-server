import { Module } from "@nestjs/common";

import { AuthController } from "./controllers/auth.controller";
import { SessionsController } from "./controllers/sessions.controller";
import { TokensController } from "./controllers/tokens.controller";
import { TranslationsController } from "./controllers/translations.controller";
import { TranslationApiService } from "./translation-api.service";

@Module({
    controllers: [AuthController, SessionsController, TokensController, TranslationsController],
    providers: [TranslationApiService],
})
export class AppModule {}
