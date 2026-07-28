'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { BufferDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/buffer.dto';

const SettingsComponent = () => {
  const t = useT();
  const { register } = useSettings();

  return (
    <div className="flex flex-col gap-[16px]">
      <Checkbox
        label={t('made_with_ai', 'Disclose AI-generated content')}
        {...register('made_with_ai')}
      />
    </div>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  comments: false,
  minimumCharacters: [],
  SettingsComponent: SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: BufferDto,
  maximumCharacters: 280,
});
