import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Observable, from, of } from 'rxjs';
import { mergeMap, catchError } from 'rxjs/operators';
import { IdempotencyKey, IdempotencyStatus } from '../entities/idempotency-key.entity';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest();
    const response = httpContext.getResponse();

    // Only intercept mutating POST requests for wallets or rewards
    const isMutatingRoute =
      request.method === 'POST' &&
      (request.url.includes('/wallets/') || request.url.includes('/rewards/'));

    if (!isMutatingRoute) {
      return next.handle();
    }

    const idempotencyKeyStr = request.headers['idempotency-key'];
    if (!idempotencyKeyStr) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    if (Array.isArray(idempotencyKeyStr) || idempotencyKeyStr.trim() === '') {
      throw new BadRequestException('Invalid Idempotency-Key header format');
    }

    // Start database transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Attempt to insert the idempotency key as IN_PROGRESS
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // 24-hour expiration retention

      const newKey = new IdempotencyKey();
      newKey.key = idempotencyKeyStr;
      newKey.status = IdempotencyStatus.IN_PROGRESS;
      newKey.expiresAt = expiresAt;

      await queryRunner.manager.insert(IdempotencyKey, newKey);

      // 2. Attach the transactional entity manager to the request object
      request.transactionManager = queryRunner.manager;

      // 3. Delegate to downstream logic (Controller -> Service)
      return next.handle().pipe(
        mergeMap(async (body) => {
          // Success: Update the key status and cache response details inside the SAME transaction
          newKey.status = IdempotencyStatus.COMPLETED;
          newKey.responseStatus = response.statusCode || 200;
          newKey.responseBody = body;

          await queryRunner.manager.save(IdempotencyKey, newKey);
          await queryRunner.commitTransaction();
          await queryRunner.release();

          return body;
        }),
        catchError((err) => {
          // Error: Rollback the database transaction and key state to permit client retries
          return from(
            (async () => {
              try {
                await queryRunner.rollbackTransaction();
              } catch (rollbackErr) {
                // Ignore errors if connection is already severed
              } finally {
                await queryRunner.release();
              }
              throw err;
            })(),
          );
        }),
      );
    } catch (insertError: any) {
      // 4. Handle Duplicate Key Case (Unique Constraint Violation)
      try {
        await queryRunner.rollbackTransaction();
      } catch (rollbackErr) {
        // Ignore
      } finally {
        await queryRunner.release();
      }

      // Query database for the existing key state
      const existingKey = await this.dataSource.manager.findOne(IdempotencyKey, {
        where: { key: idempotencyKeyStr },
      });

      if (!existingKey) {
        throw insertError;
      }

      // Case A: Key is currently processing (In Flight)
      if (existingKey.status === IdempotencyStatus.IN_PROGRESS) {
        throw new ConflictException('Request already in progress. Please retry later.');
      }

      // Case B: Key has completed (Return cached response)
      if (existingKey.status === IdempotencyStatus.COMPLETED) {
        response.status(existingKey.responseStatus || 200);
        return of(existingKey.responseBody);
      }

      throw insertError;
    }
  }
}
