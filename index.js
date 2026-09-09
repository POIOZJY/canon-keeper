const MODULE_NAME = 'canon-keeper';

jQuery(async () => {
    console.log('[Canon Keeper] 开始加载');

    try {
        const settingsHtml = await $.get(
            `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`
        );

        $('#extensions_settings').append(settingsHtml);

        $('#canon_keeper_save').on('click', () => {
            const canon = $('#canon_keeper_canon').val();
            const history = $('#canon_keeper_history').val();

            console.log('[Canon Keeper] 当前设定：', canon);
            console.log('[Canon Keeper] 历史锚点：', history);

            $('#canon_keeper_status').text('测试保存成功');
            toastr.success('Canon Keeper：测试保存成功');
        });

        console.log('[Canon Keeper] 加载完成');
    } catch (error) {
        console.error('[Canon Keeper] 加载失败', error);
    }
});
