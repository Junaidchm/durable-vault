import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParsePlayerIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!value || value.trim() === '') {
      throw new BadRequestException('Player ID is required');
    }
    if (value.length > 255) {
      throw new BadRequestException('Player ID must be 255 characters or less');
    }
    return value;
  }
}
