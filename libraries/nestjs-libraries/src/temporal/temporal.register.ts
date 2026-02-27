import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { Connection } from '@temporalio/client';

@Injectable()
export class TemporalRegister implements OnModuleInit {
  private readonly logger = new Logger(TemporalRegister.name);
  private static readonly MAX_RETRIES = 10;
  private static readonly RETRY_DELAY_MS = 5000;

  constructor(private _client: TemporalService) {}

  async onModuleInit(): Promise<void> {
    this.registerSearchAttributes();
  }

  private async registerSearchAttributes(): Promise<void> {
    for (let attempt = 1; attempt <= TemporalRegister.MAX_RETRIES; attempt++) {
      try {
        const connection = this._client?.client?.getRawClient()
          ?.connection as Connection | undefined;

        if (!connection) {
          throw new Error('Temporal connection is not available yet');
        }

        const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

        const { customAttributes } =
          await connection.operatorService.listSearchAttributes({
            namespace,
          });

        const neededAttribute = ['organizationId', 'postId'];
        const missingAttributes = neededAttribute.filter(
          (attr) => !customAttributes[attr],
        );

        if (missingAttributes.length > 0) {
          await connection.operatorService.addSearchAttributes({
            namespace,
            searchAttributes: missingAttributes.reduce((all, current) => {
              // @ts-ignore
              all[current] = 1;
              return all;
            }, {}),
          });
        }

        this.logger.log('Temporal search attributes registered successfully');
        return;
      } catch (error) {
        if (attempt < TemporalRegister.MAX_RETRIES) {
          this.logger.warn(
            `Failed to register Temporal search attributes (attempt ${attempt}/${TemporalRegister.MAX_RETRIES}): ${error.message}. Retrying in ${TemporalRegister.RETRY_DELAY_MS / 1000}s...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, TemporalRegister.RETRY_DELAY_MS),
          );
        } else {
          this.logger.error(
            `Failed to register Temporal search attributes after ${TemporalRegister.MAX_RETRIES} attempts: ${error.message}. The app will continue without custom search attributes.`,
          );
        }
      }
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [TemporalRegister],
  get exports() {
    return this.providers;
  },
})
export class TemporalRegisterMissingSearchAttributesModule {}
