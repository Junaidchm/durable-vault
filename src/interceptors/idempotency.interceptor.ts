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

const activeKeys = new Set<string>();

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

    const idempotencyKeyStr = request.headers['idempotency-key'] as string;
    console.log(`[Interceptor] Processing: ${request.method} ${request.url}, Key: ${idempotencyKeyStr}, ActiveKeys:`, Array.from(activeKeys));

    if (!idempotencyKeyStr) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    if (Array.isArray(idempotencyKeyStr) || idempotencyKeyStr.trim() === '') {
      throw new BadRequestException('Invalid Idempotency-Key header format');
    }

    // Check application-level in-flight lock to return 409 Conflict immediately
    // rather than blocking at the database level during concurrent identical requests
    if (activeKeys.has(idempotencyKeyStr)) {
      throw new ConflictException('Request already in progress. Please retry later.');
    }

    activeKeys.add(idempotencyKeyStr);

    let isTxStarted = false;
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      isTxStarted = true;

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
          // Injectable delay hook for mid-transaction process crash simulation
          const delayHeader = request.headers['x-test-delay-ms'];
          if (delayHeader) {
            const delayMs = parseInt(delayHeader as string, 10);
            if (!isNaN(delayMs) && delayMs > 0) {
              console.log(`[IdempotencyInterceptor] Injecting crash simulation delay of ${delayMs}ms before commit`);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }

          // Success: Update the key status and cache response details inside the SAME transaction
          newKey.status = IdempotencyStatus.COMPLETED;
          newKey.responseStatus = response.statusCode || 200;
          newKey.responseBody = body;

          await queryRunner.manager.save(IdempotencyKey, newKey);
          await queryRunner.commitTransaction();
          await queryRunner.release();

          activeKeys.delete(idempotencyKeyStr);

          return body;
        }),
        catchError((err) => {
          activeKeys.delete(idempotencyKeyStr);
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
      activeKeys.delete(idempotencyKeyStr);
      // 4. Handle Duplicate Key Case (Unique Constraint Violation) or Connection Failure
      try {
        if (queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
      } catch (rollbackErr) {
        // Ignore
      } finally {
        await queryRunner.release();
      }

      // If database connection or transaction start failed, throw that error immediately
      if (!isTxStarted) {
        throw insertError;
      }

      // Query database for the existing key state
      let existingKey: IdempotencyKey | null = null;
      try {
        existingKey = await this.dataSource.manager.findOne(IdempotencyKey, {
          where: { key: idempotencyKeyStr },
        });
      } catch (queryErr) {
        throw insertError;
      }

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
